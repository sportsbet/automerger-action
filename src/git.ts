import { spawn } from "child_process"
import { TimeoutError, logger } from "./main"

export class ExitError extends Error {
	code: number | null
	stdout: string | null
	constructor(message: string, code: number | null, stdout: string | null = null) {
		super(message)
		this.code = code
		this.stdout = stdout
	}
}

const FETCH_DEPTH = 10

const COMMON_ARGS = ["-c", "user.name=GitHub", "-c", "user.email=noreply@github.com"]

export function git(cwd: string, ...args: (string | null)[]): Promise<string> {
	const stdio: ("ignore" | "pipe" | "inherit")[] = [
		"ignore",
		"pipe",
		logger.level === "trace" || logger.level === "debug" ? "inherit" : "ignore"
	]
	// the URL passed to the clone command could contain a password!
	const command = args.includes("clone") ? "git clone" : `git ${args.join(" ")}`
	logger.debug("Executing", command)
	return new Promise((resolve, reject) => {
		const proc = spawn("git", COMMON_ARGS.concat(args.filter(a => a !== null) as string[]), { cwd, stdio })
		const buffers: Uint8Array[] = []
		if (proc.stdout) {
			proc.stdout.on("data", data => buffers.push(data))
		}
		proc.on("error", () => {
			reject(new Error(`command failed: ${command}`))
		})
		proc.on("exit", code => {
			const data = Buffer.concat(buffers)
			const commandOutput = data.toString("utf8").trim()
			if (code === 0) {
				resolve(commandOutput)
			} else {
				reject(new ExitError(`command failed with code ${code}: ${command}`, code, commandOutput))
			}
		})
	})
}

export async function shallowClone(from: string, to: string, branch: string) {
	await git(
		".",
		"clone",
		"--quiet",
		"--shallow-submodules",
		"--no-tags",
		"--branch",
		branch,
		"--depth",
		`${FETCH_DEPTH}`,
		from,
		to
	)
}

export async function fullClone(from: string, to: string) {
	await git(".", "clone", "--quiet", "--no-tags", from, to)
}

export async function fetch(dir: string, branch: string) {
	await git(dir, "fetch", "--quiet", "--depth", `${FETCH_DEPTH}`, "origin", `${branch}:refs/remotes/origin/${branch}`)
}

export async function fetchUntilMergeBase(dir: string, branch: string, timeout: number) {
	const maxTime = new Date().getTime() + timeout
	const ref = `refs/remotes/origin/${branch}`
	while (new Date().getTime() < maxTime) {
		const base = await mergeBase(dir, "HEAD", ref)
		if (base) {
			const bases = [base]
			const parents = await mergeCommits(dir, ref)
			let fetchMore = false
			for (const parent of parents.flat()) {
				const b = await mergeBase(dir, parent, ref)
				if (b) {
					if (!bases.includes(b)) {
						bases.push(b)
					}
				} else {
					// we found a commit which does not have a common ancestor with
					// the branch we want to merge, so we need to fetch more
					fetchMore = true
					break
				}
			}
			if (!fetchMore) {
				const commonBase = await mergeBase(dir, ...bases)
				if (!commonBase) {
					throw new Error(`failed to find common base for ${bases}`)
				}
				return commonBase
			}
		}
		await fetchDeepen(dir)
	}
	throw new TimeoutError()
}

export async function fetchDeepen(dir: string) {
	await git(dir, "fetch", "--quiet", "--deepen", `${FETCH_DEPTH}`)
}

export async function mergeBase(dir: string, ...refs: string[]) {
	if (refs.length === 1) {
		return refs[0]
	} else if (refs.length < 1) {
		throw new Error("empty refs!")
	}
	let todo = refs
	try {
		while (todo.length > 1) {
			const base = await git(dir, "merge-base", todo[0], todo[1])
			todo = [base].concat(todo.slice(2))
		}
		return todo[0]
	} catch (e) {
		if (e instanceof ExitError && e.code === 1) {
			return null
		} else {
			throw e
		}
	}
}

/**
 * Returns `null` if merge can be performed cleanly, otherwise returns a string containing the
 * merge result.
 *
 * @param dir Path to git
 * @param base Branch to merge into
 * @param mergingBranch Branch that's being merged
 */
export async function canMergeCleanly(dir: string, base: string, mergingBranch: string): Promise<string | null> {
	await git(dir, "checkout", base)
	await git(dir, "pull", "--quiet", "--no-commit")
	await git(dir, "fetch", "--quiet", "origin", `${mergingBranch}:refs/remotes/origin/${mergingBranch}`)
	try {
		await git(dir, "merge", "--quiet", "--no-commit", mergingBranch)
		await abortMerge(dir)
	} catch (err) {
		await abortMerge(dir)
		if (err instanceof ExitError) {
			// Doesn't merge cleanly
			return err.stdout
		}
	}
	return null
}

/**
 * Returns `null` if merge performed cleanly, otherwise returns a string containing the
 * merge result.
 *
 * @param dir Path to git
 * @param base Branch to merge into
 * @param mergingBranch Branch that's being merged
 * @param message Commit message. Uses the git default if undefined.
 */
export async function merge(
	dir: string,
	base: string,
	mergingBranch: string,
	message?: string
): Promise<string | null> {
	try {
		if (message) {
			await git(dir, "merge", "--quiet", "--no-edit", "-m", message, mergingBranch)
		} else {
			await git(dir, "merge", "--quiet", "--no-edit", mergingBranch)
		}
	} catch (err) {
		await abortMerge(dir)
		if (err instanceof ExitError) {
			// Doesn't merge cleanly
			return err.stdout
		}
	}
	return null
}

export async function abortMerge(dir: string): Promise<void> {
	try {
		await git(dir, "merge", "--abort")
	} catch (err) {
		if (err instanceof ExitError) {
			if (err.code === 128) {
				return
			}
		}
		throw err
	}
}

export async function setRemote(dir: string, remote: string, url: string): Promise<string> {
	return await git(dir, "remote", "set-url", remote, url)
}

export async function mergeCommits(dir: string, ref: string) {
	return (await git(dir, "rev-list", "--parents", `${ref}..HEAD`))
		.split(/\n/g)
		.map(line => line.split(/ /g).slice(1))
		.filter(commit => commit.length > 1)
}

export async function head(dir: string) {
	return await git(dir, "show-ref", "--head", "-s", "/HEAD")
}

export async function sha(dir: string, branch: string) {
	return await git(dir, "show-ref", "-s", `refs/remotes/origin/${branch}`)
}

export async function rebase(dir: string, branch: string) {
	return await git(dir, "rebase", "--quiet", "--autosquash", branch)
}

export async function push(dir: string, force: boolean, branch: string) {
	return await git(dir, "push", "--quiet", force ? "--force-with-lease" : null, "origin", branch)
}
