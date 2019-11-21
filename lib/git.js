"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const child_process_1 = require("child_process");
const main_1 = require("./main");
class ExitError extends Error {
    constructor(message, code, stdout = null) {
        super(message);
        this.code = code;
        this.stdout = stdout;
    }
}
exports.ExitError = ExitError;
const FETCH_DEPTH = 10;
const COMMON_ARGS = ["-c", "user.name=GitHub", "-c", "user.email=noreply@github.com"];
function rawGit(cwd, args) {
    const stdio = [
        "ignore",
        "pipe",
        main_1.logger.level === "trace" || main_1.logger.level === "debug" ? "inherit" : "ignore"
    ];
    // the URL passed to the clone command could contain a password!
    const command = args.includes("clone") ? "git clone" : `git ${args.join(" ")}`;
    main_1.logger.debug("Executing", command);
    return new Promise((resolve, reject) => {
        const proc = child_process_1.spawn("git", args, { cwd, stdio });
        const buffers = [];
        if (proc.stdout) {
            proc.stdout.on("data", data => buffers.push(data));
        }
        proc.on("error", () => {
            reject(new Error(`command failed: ${command}`));
        });
        proc.on("exit", code => {
            const data = Buffer.concat(buffers);
            const commandOutput = data.toString("utf8").trim();
            if (code === 0) {
                resolve(commandOutput);
            }
            else {
                reject(new ExitError(`command failed with code ${code}: ${command}`, code, commandOutput));
            }
        });
    });
}
function git(cwd, ...args) {
    return rawGit(cwd, COMMON_ARGS.concat(args.filter(a => a !== null)));
}
exports.git = git;
async function shallowClone(from, to, branch) {
    await git(".", "clone", "--quiet", "--shallow-submodules", "--no-tags", "--branch", branch, "--depth", `${FETCH_DEPTH}`, from, to);
}
exports.shallowClone = shallowClone;
async function fullClone(from, to) {
    await git(".", "clone", "--quiet", "--no-tags", from, to);
}
exports.fullClone = fullClone;
async function fetch(dir, branch) {
    await git(dir, "fetch", "--quiet", "--depth", `${FETCH_DEPTH}`, "origin", `${branch}:refs/remotes/origin/${branch}`);
}
exports.fetch = fetch;
async function fetchUntilMergeBase(dir, branch, timeout) {
    const maxTime = new Date().getTime() + timeout;
    const ref = `refs/remotes/origin/${branch}`;
    while (new Date().getTime() < maxTime) {
        const base = await mergeBase(dir, "HEAD", ref);
        if (base) {
            const bases = [base];
            const parents = await mergeCommits(dir, ref);
            let fetchMore = false;
            for (const parent of parents.flat()) {
                const b = await mergeBase(dir, parent, ref);
                if (b) {
                    if (!bases.includes(b)) {
                        bases.push(b);
                    }
                }
                else {
                    // we found a commit which does not have a common ancestor with
                    // the branch we want to merge, so we need to fetch more
                    fetchMore = true;
                    break;
                }
            }
            if (!fetchMore) {
                const commonBase = await mergeBase(dir, ...bases);
                if (!commonBase) {
                    throw new Error(`failed to find common base for ${bases}`);
                }
                return commonBase;
            }
        }
        await fetchDeepen(dir);
    }
    throw new main_1.TimeoutError();
}
exports.fetchUntilMergeBase = fetchUntilMergeBase;
async function fetchDeepen(dir) {
    await git(dir, "fetch", "--quiet", "--deepen", `${FETCH_DEPTH}`);
}
exports.fetchDeepen = fetchDeepen;
async function mergeBase(dir, ...refs) {
    if (refs.length === 1) {
        return refs[0];
    }
    else if (refs.length < 1) {
        throw new Error("empty refs!");
    }
    let todo = refs;
    try {
        while (todo.length > 1) {
            const base = await git(dir, "merge-base", todo[0], todo[1]);
            todo = [base].concat(todo.slice(2));
        }
        return todo[0];
    }
    catch (e) {
        if (e instanceof ExitError && e.code === 1) {
            return null;
        }
        else {
            throw e;
        }
    }
}
exports.mergeBase = mergeBase;
async function removeGitHubConfigs(dir) {
    return await rawGit(dir, ["config", "--remove-section", "http.https://github.com/"]);
}
exports.removeGitHubConfigs = removeGitHubConfigs;
/**
 * Returns `null` if merge can be performed cleanly, otherwise returns a string containing the
 * merge result.
 *
 * @param dir Path to git
 * @param base Branch to merge into
 * @param mergingBranch Branch that's being merged
 */
async function canMergeCleanly(dir, base, mergingBranch) {
    await git(dir, "checkout", base);
    await git(dir, "pull", "--quiet", "--no-commit");
    await git(dir, "fetch", "--quiet", "origin", `${mergingBranch}:refs/remotes/origin/${mergingBranch}`);
    try {
        await git(dir, "merge", "--quiet", "--no-commit", `refs/remotes/origin/${mergingBranch}`);
        await abortMerge(dir);
    }
    catch (err) {
        await abortMerge(dir);
        if (err instanceof ExitError) {
            // Doesn't merge cleanly
            return err.stdout;
        }
    }
    return null;
}
exports.canMergeCleanly = canMergeCleanly;
/**
 * Returns `null` if merge performed cleanly, otherwise returns a string containing the
 * merge result.
 *
 * @param dir Path to git
 * @param base Branch to merge into
 * @param mergingBranch Branch that's being merged
 * @param message Commit message. Uses the git default if undefined.
 */
async function merge(dir, base, mergingBranch, message) {
    await git(dir, "checkout", base);
    await git(dir, "pull", "--quiet", "--no-commit");
    await git(dir, "fetch", "--quiet", "origin", `${mergingBranch}:refs/remotes/origin/${mergingBranch}`);
    try {
        if (message) {
            await git(dir, "merge", "--quiet", "--no-edit", "-m", message, `refs/remotes/origin/${mergingBranch}`);
        }
        else {
            await git(dir, "merge", "--quiet", "--no-edit", `refs/remotes/origin/${mergingBranch}`);
        }
    }
    catch (err) {
        await abortMerge(dir);
        if (err instanceof ExitError) {
            // Doesn't merge cleanly
            return err.stdout;
        }
    }
    return null;
}
exports.merge = merge;
async function abortMerge(dir) {
    try {
        await git(dir, "merge", "--abort");
    }
    catch (err) {
        if (err instanceof ExitError) {
            if (err.code === 128) {
                return;
            }
        }
        throw err;
    }
}
exports.abortMerge = abortMerge;
async function setRemote(dir, remote, url) {
    return await git(dir, "remote", "set-url", remote, url);
}
exports.setRemote = setRemote;
async function mergeCommits(dir, ref) {
    return (await git(dir, "rev-list", "--parents", `${ref}..HEAD`))
        .split(/\n/g)
        .map(line => line.split(/ /g).slice(1))
        .filter(commit => commit.length > 1);
}
exports.mergeCommits = mergeCommits;
async function head(dir) {
    return await git(dir, "show-ref", "--head", "-s", "/HEAD");
}
exports.head = head;
async function sha(dir, branch) {
    return await git(dir, "show-ref", "-s", `refs/remotes/origin/${branch}`);
}
exports.sha = sha;
async function rebase(dir, branch) {
    return await git(dir, "rebase", "--quiet", "--autosquash", branch);
}
exports.rebase = rebase;
async function push(dir, force, branch) {
    return await git(dir, "push", "--quiet", force ? "--force-with-lease" : null, "origin", branch);
}
exports.push = push;
