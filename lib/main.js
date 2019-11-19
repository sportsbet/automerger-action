"use strict";
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const github = __importStar(require("@actions/github"));
const fs_1 = require("fs");
const fse = __importStar(require("fs-extra"));
const util = __importStar(require("util"));
const tmp = __importStar(require("tmp"));
const git = __importStar(require("./git"));
const rest_1 = __importDefault(require("@octokit/rest"));
const webhooks_1 = __importDefault(require("@octokit/webhooks"));
const app_auth_1 = require("./app_auth");
class ClientError extends Error {
}
// Exits with not an error
class NoError extends Error {
}
exports.NoError = NoError;
class TimeoutError extends Error {
}
exports.TimeoutError = TimeoutError;
const MAX_PR_COUNT = 10;
function log(prefix, obj) {
    if (process.env.NODE_ENV !== "test") {
        const str = obj.map((o) => (typeof o === "object" ? inspect(o) : o));
        if (prefix) {
            console.log.apply(console, [prefix, ...str]);
        }
        else {
            console.log.apply(console, str);
        }
    }
}
exports.logger = {
    level: "info",
    trace: (...str) => {
        if (exports.logger.level === "trace") {
            log("TRACE", str);
        }
    },
    debug: (...str) => {
        if (exports.logger.level === "trace" || exports.logger.level === "debug") {
            log("DEBUG", str);
        }
    },
    info: (...str) => log("INFO ", str),
    error: (...str) => {
        if (str.length === 1) {
            if (str[0] instanceof Error) {
                if (exports.logger.level === "trace" || exports.logger.level === "debug") {
                    log(null, [str[0].stack || str[0]]);
                }
                else {
                    log("ERROR", [str[0].message || str[0]]);
                }
            }
        }
        else {
            log("ERROR", str);
        }
    }
};
function inspect(obj) {
    return util.inspect(obj, false, null, true);
}
function tmpdir(callback) {
    async function handle(path) {
        try {
            return await callback(path);
        }
        finally {
            await fse.remove(path);
        }
    }
    return new Promise((resolve, reject) => {
        tmp.dir((err, path) => {
            if (err) {
                reject(err);
            }
            else {
                handle(path).then(resolve, reject);
            }
        });
    });
}
function env(name) {
    const val = process.env[name];
    if (!val || !val.length) {
        throw new ClientError(`environment variable ${name} not set!`);
    }
    return val;
}
async function delay(timeout, value) {
    return new Promise(res => setTimeout(() => res(value), timeout));
}
async function retry(retries, sleep, doInitial, doRetry, doFailed) {
    if (await doInitial()) {
        return true;
    }
    for (let run = 1; run <= retries; run++) {
        exports.logger.info(`Retrying after ${sleep} ms ... (${run}/${retries})`);
        await delay(sleep);
        if (await doRetry()) {
            return true;
        }
    }
    await doFailed();
    return false;
}
async function checkMergeability(octokit, pr, retries = 3) {
    const pull = await octokit.pulls.get({
        owner: pr.base.repo.owner.login,
        repo: pr.base.repo.name,
        number: pr.number
    });
    if (pull.data.mergeable === null) {
        if (retries > 0) {
            await delay(2000);
            return checkMergeability(octokit, pr, retries - 1);
        }
        else {
            return pull.data;
        }
    }
    else {
        return pull.data;
    }
}
async function run() {
    try {
        const actionsToken = core.getInput("githubToken", { required: true });
        core.setSecret(actionsToken);
        const eventPath = env("GITHUB_EVENT_PATH");
        const eventName = env("GITHUB_EVENT_NAME");
        const eventDataStr = await fs_1.promises.readFile(eventPath, { encoding: "utf8" });
        const eventData = JSON.parse(eventDataStr);
        const octokit = new github.GitHub(actionsToken);
        await runGitHubAction(octokit, eventData, eventName);
    }
    catch (error) {
        if (error instanceof NoError) {
            process.exit(0);
        }
        else {
            core.setFailed(error);
            process.exit(1);
        }
    }
}
const VALID_EVENTS = ["push", "status", "pull_request", "pull_request_review"];
async function runGitHubAction(octokit, eventData, eventName) {
    exports.logger.info("Event name:", eventName);
    exports.logger.trace("Event data:", eventData);
    const webhooks = new webhooks_1.default({
        secret: "no"
    });
    webhooks.on("pull_request", async ({ payload }) => {
        await onPR(octokit, payload);
    });
    webhooks.on("pull_request_review", async ({ payload }) => {
        await onPRReview(octokit, payload);
    });
    webhooks.on("status", async ({ payload }) => {
        await onStatus(octokit, payload);
    });
    webhooks.on("push", async ({ payload }) => {
        await onPush(octokit, payload);
    });
    if (VALID_EVENTS.includes(eventName)) {
        await webhooks.verifyAndReceive({
            id: "",
            name: eventName,
            payload: eventData,
            signature: webhooks.sign(eventData)
        });
        throw new NoError();
    }
    else {
        throw new ClientError(`invalid event type: ${eventName}`);
    }
}
const RELEVANT_PR_ACTIONS = [
    "labeled",
    "unlabeled",
    "synchronize",
    "opened",
    "edited",
    "ready_for_review",
    "reopened",
    "unlocked"
];
async function onPR(octokit, payload) {
    if (!RELEVANT_PR_ACTIONS.includes(payload.action)) {
        exports.logger.info(`PR action ignored ${payload.action}`);
        throw new NoError();
    }
    const realPR = await checkMergeability(octokit, payload.pull_request);
    return processPR(octokit, realPR);
}
async function onPRReview(octokit, payload) {
    if (payload.action === "submitted") {
        if (payload.review.state === "approved") {
            const realPR = await checkMergeability(octokit, payload.pull_request);
            return processPR(octokit, realPR);
        }
        else {
            exports.logger.info(`Review state is not approved: ${payload.review.state}`);
            throw new NoError();
        }
    }
    else {
        exports.logger.info(`Ignoring pull_request_review: ${payload.action} -> ${payload.review.state}`);
        throw new NoError();
    }
}
async function onStatus(octokit, payload) { }
async function onPush(octokit, payload) {
    if (!payload.ref.startsWith("refs/heads/")) {
        exports.logger.info(`Push '${payload.ref}' does not reference a branch`);
        throw new NoError();
    }
    const branch = payload.ref.substr(11);
    exports.logger.info(`Push to branch '${branch}'...`);
    if (!payload.repository.owner.name) {
        exports.logger.info(`Push '${payload.ref}' repository does not have an owner`);
        throw new NoError();
    }
    const { data: pullRequests } = await octokit.pulls.list({
        owner: payload.repository.owner.name,
        repo: payload.repository.name,
        state: "open",
        base: branch,
        sort: "updated",
        direction: "desc",
        per_page: MAX_PR_COUNT
    });
    exports.logger.trace("PR list:", pullRequests);
    if (pullRequests.length > 0) {
        exports.logger.info(`Open PRs: ${pullRequests.length}`);
    }
    else {
        exports.logger.info(`No open PRs for ${branch}`);
        throw new NoError();
    }
    let updated = 0;
    for (const pullRequest of pullRequests) {
        try {
            const realPR = await checkMergeability(octokit, pullRequest);
            await processPR(octokit, realPR);
            updated++;
        }
        catch (error) {
            if (error instanceof NoError) {
                exports.logger.trace(`PR #${pullRequest.number} skipped`);
            }
            else {
                exports.logger.error(error);
            }
        }
    }
    if (updated > 0) {
        exports.logger.info(`${updated} PR${updated === 1 ? "" : "s"} based on ${branch} have been updated`);
    }
    else {
        exports.logger.info(`No PRs based on ${branch} have been updated`);
        throw new NoError();
    }
}
function isMergingIntoRelease(pr) {
    if (pr.base.ref === "release-ios" || pr.base.ref === "release-web" || pr.base.ref.startsWith("releases/")) {
        return true;
    }
    return false;
}
async function processPR(octokit, pr) {
    if (pr.mergeable_state !== "clean") {
        exports.logger.info(`PR #${pr.number} mergeability blocked: ${pr.mergeable_state}`);
        throw new NoError();
    }
    if (!pr.labels.map(l => l.name).includes("Automerge")) {
        exports.logger.info(`PR #${pr.number} has no Automerge label`);
        throw new NoError();
    }
    if (pr.base.ref !== "master" && !isMergingIntoRelease(pr)) {
        exports.logger.info(`PR #${pr.number} isn't merging into master or release. Ignoring.`);
        throw new NoError();
    }
    return automerge(octokit, pr);
}
async function addCommentToPR(octokit, pr, comment) {
    await octokit.issues.createComment({
        issue_number: pr.number,
        owner: pr.base.repo.owner.login,
        repo: pr.base.repo.name,
        body: comment
    });
}
// Sets git remote to use the credentials for the Sportsbot github app
// This allows us to give it write permission to master
async function setGitRemoteToAppPermission() {
    const appId = core.getInput("appId", { required: true });
    const appKey = core.getInput("appKey", { required: true });
    core.setSecret(appKey);
    const repoSlug = env("GITHUB_REPOSITORY");
    const repoDir = env("GITHUB_WORKSPACE");
    const jwt = app_auth_1.generateJwt(appKey, appId);
    const jwtOctokit = new rest_1.default({
        auth: `Bearer ${jwt}`
    });
    const installation = await app_auth_1.getInstallationFromGitHub(jwtOctokit, repoSlug);
    const accessToken = await app_auth_1.newAccessTokenFromGitHub(jwtOctokit, installation.id);
    core.setSecret(accessToken.token);
    const remoteURL = app_auth_1.gitRemote(accessToken.token, repoSlug);
    await git.setRemote(repoDir, "origin", remoteURL);
}
async function tryMerge(octokit, pr, mergeMethod, commitMessage) {
    async function mergePR() {
        try {
            const res = await octokit.pulls.merge({
                owner: pr.head.repo.owner.login,
                repo: pr.head.repo.name,
                pull_number: pr.number,
                commit_message: commitMessage,
                sha: pr.head.sha,
                merge_method: mergeMethod
            });
            if (res.status === 200) {
                return true;
            }
            else {
                exports.logger.info("Failed to merge PR:", res.status);
                return false;
            }
        }
        catch (e) {
            exports.logger.info("Failed to merge PR:", e.message);
            return false;
        }
    }
    return retry(3, 10000, mergePR, mergePR, () => Promise.resolve(false));
}
// PRs to releases/* and to release-* need to be automatically merged
// back to master, or have the PR marked as not ready if there's some kind
// of conflict to master.
async function checkRollupToMaster(octokit, pr) {
    const repoDir = env("GITHUB_WORKSPACE");
    const context = "Sportsbot: release to master automerge";
    let mergeMsg = await git.canMergeCleanly(repoDir, "master", pr.head.ref);
    const existingStatuses = await octokit.repos.listStatusesForRef({
        ref: pr.head.sha,
        owner: pr.base.repo.owner.login,
        repo: pr.base.repo.name
    });
    const myStatuses = existingStatuses.data.filter(s => s.context === context);
    let needsComment = true;
    if (myStatuses.length > 1) {
        if (myStatuses[0].state === "failure" || myStatuses[0].state === "error") {
            needsComment = false;
        }
    }
    if (mergeMsg !== null) {
        const desc = "Cannot merge into `master`. Git output:\n\n```" + mergeMsg + "```";
        if (needsComment) {
            await addCommentToPR(octokit, pr, desc);
        }
        await octokit.repos.createStatus({
            sha: pr.head.sha,
            owner: pr.base.repo.owner.login,
            repo: pr.base.repo.name,
            state: "failure",
            description: desc,
            context
        });
        return false;
    }
    return true;
}
// PRs to master should be automatically merged using the correct merge method
// when they are ready, if they are labelled as needing an automerge.
async function automerge(octokit, pr) {
    let mergeMethod = "merge";
    let title = undefined;
    if (pr.base.ref === "master") {
        mergeMethod = "squash";
        title = `${pr.title} (#${pr.number})`;
    }
    if (isMergingIntoRelease(pr)) {
        await setGitRemoteToAppPermission();
        const canMerge = await checkRollupToMaster(octokit, pr);
        if (!canMerge) {
            // abort
            return;
        }
        // Merge into release first...
        if (!tryMerge(octokit, pr, mergeMethod, title)) {
            throw "Merge failed";
        }
        // Merge and push to master
        const repoDir = env("GITHUB_WORKSPACE");
        const mergeMsg = await git.merge(repoDir, "master", pr.head.ref);
        if (mergeMsg !== null) {
            exports.logger.error(`Automerge from release to master failure: ${mergeMsg}`);
        }
        await git.push(repoDir, false, "master");
        return;
    }
    // Is a feature branch into master -- merge
    if (!tryMerge(octokit, pr, mergeMethod, title)) {
        throw "Merge failed";
    }
}
run();
