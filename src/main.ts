import * as core from "@actions/core"
import * as github from "@actions/github"
import { promises as fs } from "fs"
import * as fse from "fs-extra"
import * as util from "util"
import * as tmp from "tmp"
import * as git from "./git"
import Octokit from "@octokit/rest"
import WebhooksAPI from "@octokit/webhooks"
import { getInstallationFromGitHub, generateJwt, newAccessTokenFromGitHub, gitRemote } from "./app_auth"

// A lot of code was "borrowed" from https://github.com/pascalgn/automerge-action
type Nullary = null | undefined

class ClientError extends Error {}

// Exits with not an error
export class NoError extends Error {}

export class TimeoutError extends Error {}

const MAX_PR_COUNT = 10

function log(prefix: string | Nullary, obj: any) {
	if (process.env.NODE_ENV !== "test") {
		const str = obj.map((o: any) => (typeof o === "object" ? inspect(o) : o))
		if (prefix) {
			console.log.apply(console, [prefix, ...str])
		} else {
			console.log.apply(console, str)
		}
	}
}

export const logger = {
	level: "info",

	trace: (...str: any[]) => {
		if (logger.level === "trace") {
			log("TRACE", str)
		}
	},

	debug: (...str: any[]) => {
		if (logger.level === "trace" || logger.level === "debug") {
			log("DEBUG", str)
		}
	},

	info: (...str: any[]) => log("INFO ", str),

	error: (...str: any[]) => {
		if (str.length === 1) {
			if (str[0] instanceof Error) {
				if (logger.level === "trace" || logger.level === "debug") {
					log(null, [str[0].stack || str[0]])
				} else {
					log("ERROR", [str[0].message || str[0]])
				}
			}
		} else {
			log("ERROR", str)
		}
	}
}

function inspect(obj: any) {
	return util.inspect(obj, false, null, true)
}

function tmpdir<T>(callback: (path: string) => Promise<T>): Promise<T> {
	async function handle(path: string) {
		try {
			return await callback(path)
		} finally {
			await fse.remove(path)
		}
	}
	return new Promise((resolve, reject) => {
		tmp.dir((err, path) => {
			if (err) {
				reject(err)
			} else {
				handle(path).then(resolve, reject)
			}
		})
	})
}

function env(name: string): string {
	const val = process.env[name]
	if (!val || !val.length) {
		throw new ClientError(`environment variable ${name} not set!`)
	}
	return val
}

interface RefCommon {
	ref: string
	sha: string
	user: OwnerCommon
	repo: RepoCommon
}

interface OwnerCommon {
	login: string
}

interface RepoCommon {
	id: number
	name: string
	full_name: string
	owner: OwnerCommon
}

interface PullRequestCommon {
	number: number
	head: RefCommon
	base: RefCommon
	title: string
	merge_commit_sha: string | null
	labels: {
		name: string
	}[]
}

interface PullRequestExtended extends PullRequestCommon {
	mergeable: boolean | null
	mergeable_state: "behind" | "blocked" | "clean" | "dirty" | "draft" | "has_hooks" | "unknown" | "unstable" | string
}

async function delay<T>(timeout: number, value?: T): Promise<T> {
	return new Promise(res => setTimeout(() => res(value), timeout))
}

async function retry(
	retries: number,
	sleep: number,
	doInitial: () => Promise<boolean>,
	doRetry: () => Promise<boolean>,
	doFailed: () => Promise<boolean>
): Promise<boolean> {
	if (await doInitial()) {
		return true
	}

	for (let run = 1; run <= retries; run++) {
		logger.info(`Retrying after ${sleep} ms ... (${run}/${retries})`)
		await delay(sleep)

		if (await doRetry()) {
			return true
		}
	}

	await doFailed()
	return false
}

async function checkMergeability(octokit: Octokit, pr: PullRequestCommon, retries = 3): Promise<PullRequestExtended> {
	const pull = await octokit.pulls.get({
		owner: pr.base.repo.owner.login,
		repo: pr.base.repo.name,
		pull_number: pr.number
	})
	if (pull.data.mergeable === null || pull.data.mergeable_state !== "clean") {
		if (retries > 0) {
			logger.info(
				`Retrying mergeability check because mergeable = '${pull.data.mergeable}'` +
					`and state = '${pull.data.mergeable_state}'. retries: (${run}/${retries})`
			)
			await delay(2000)
			return checkMergeability(octokit, pr, retries - 1)
		} else {
			return pull.data
		}
	} else {
		return pull.data
	}
}

async function run() {
	try {
		const actionsToken = core.getInput("githubToken", { required: true })
		core.setSecret(actionsToken)

		const eventPath = env("GITHUB_EVENT_PATH")
		const eventName = env("GITHUB_EVENT_NAME")

		const eventDataStr = await fs.readFile(eventPath, { encoding: "utf8" })
		const eventData = JSON.parse(eventDataStr)

		const octokit = new github.GitHub(actionsToken)
		await runGitHubAction(octokit, eventData, eventName)
	} catch (error) {
		if (error instanceof NoError) {
			process.exit(0)
		} else {
			core.setFailed(error)
			process.exit(1)
		}
	}
}

function makeGeneralHandler(octokit: Octokit, handler: (octokit: Octokit, payload: any) => Promise<void>) {
	return async ({ payload }) => {
		try {
			await handler(octokit, payload)
		} catch (error) {
			if (error instanceof NoError) {
				process.exit(0)
			} else {
				process.exit(1)
			}
		}
	}
}

const VALID_EVENTS = ["push", "status", "pull_request", "pull_request_review"]

async function runGitHubAction(octokit: Octokit, eventData: any, eventName: string) {
	logger.info("Event name:", eventName)
	logger.trace("Event data:", eventData)

	const webhooks = new WebhooksAPI({
		secret: "no"
	})

	webhooks.on("pull_request", makeGeneralHandler(octokit, onPR))
	webhooks.on("pull_request_review", makeGeneralHandler(octokit, onPRReview))
	webhooks.on("status", makeGeneralHandler(octokit, onStatus))
	webhooks.on("push", makeGeneralHandler(octokit, onPush))

	if (VALID_EVENTS.includes(eventName)) {
		await webhooks.verifyAndReceive({
			id: "",
			name: eventName,
			payload: eventData,
			signature: webhooks.sign(eventData)
		})
		throw new NoError()
	} else {
		throw new ClientError(`invalid event type: ${eventName}`)
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
]

async function onPR(octokit: Octokit, payload: WebhooksAPI.WebhookPayloadPullRequest) {
	if (!RELEVANT_PR_ACTIONS.includes(payload.action)) {
		logger.info(`PR action ignored ${payload.action}`)
		throw new NoError()
	}
	const realPR = await checkMergeability(octokit, payload.pull_request)
	return processPR(octokit, realPR)
}

async function onPRReview(octokit: Octokit, payload: WebhooksAPI.WebhookPayloadPullRequestReview) {
	if (payload.action === "submitted") {
		if (payload.review.state === "approved") {
			const realPR = await checkMergeability(octokit, payload.pull_request)
			return processPR(octokit, realPR)
		} else {
			logger.info(`Review state is not approved: ${payload.review.state}`)
			throw new NoError()
		}
	} else {
		logger.info(`Ignoring pull_request_review: ${payload.action} -> ${payload.review.state}`)
		throw new NoError()
	}
}

async function onStatus(octokit: Octokit, payload: WebhooksAPI.WebhookPayloadStatus): Promise<void> {}

async function onPush(octokit: Octokit, payload: WebhooksAPI.WebhookPayloadPush): Promise<void> {
	if (!payload.ref.startsWith("refs/heads/")) {
		logger.info(`Push '${payload.ref}' does not reference a branch`)
		throw new NoError()
	}
	const branch = payload.ref.substr(11)
	logger.info(`Push to branch '${branch}'...`)

	if (!payload.repository.owner.name) {
		logger.info(`Push '${payload.ref}' repository does not have an owner`)
		throw new NoError()
	}

	const { data: pullRequests } = await octokit.pulls.list({
		owner: payload.repository.owner.name,
		repo: payload.repository.name,
		state: "open",
		base: branch,
		sort: "updated",
		direction: "desc",
		per_page: MAX_PR_COUNT
	})

	logger.trace("PR list:", pullRequests)

	if (pullRequests.length > 0) {
		logger.info(`Open PRs: ${pullRequests.length}`)
	} else {
		logger.info(`No open PRs for ${branch}`)
		throw new NoError()
	}

	let updated = 0
	for (const pullRequest of pullRequests) {
		try {
			const realPR = await checkMergeability(octokit, pullRequest)
			await processPR(octokit, realPR)
			updated++
		} catch (error) {
			if (error instanceof NoError) {
				logger.trace(`PR #${pullRequest.number} skipped`)
			} else {
				logger.error(error)
			}
		}
	}
	if (updated > 0) {
		logger.info(`${updated} PR${updated === 1 ? "" : "s"} based on ${branch} have been updated`)
	} else {
		logger.info(`No PRs based on ${branch} have been updated`)
		throw new NoError()
	}
}

function isMergingIntoRelease(pr: PullRequestCommon): boolean {
	if (pr.base.ref === "release-ios" || pr.base.ref === "release-web" || pr.base.ref.startsWith("releases/")) {
		return true
	}
	return false
}

async function processPR(octokit: Octokit, pr: PullRequestExtended): Promise<void> {
	if (pr.mergeable_state !== "clean") {
		logger.info(`PR #${pr.number} mergeability blocked: ${pr.mergeable_state}`)
		throw new NoError()
	}
	if (!pr.labels.map(l => l.name).includes("Automerge")) {
		logger.info(`PR #${pr.number} has no Automerge label`)
		throw new NoError()
	}
	if (pr.base.ref !== "master" && !isMergingIntoRelease(pr)) {
		logger.info(`PR #${pr.number} isn't merging into master or release. Ignoring.`)
		throw new NoError()
	}

	return automerge(octokit, pr)
}

async function addCommentToPR(octokit: Octokit, pr: PullRequestCommon, comment: string): Promise<void> {
	await octokit.issues.createComment({
		issue_number: pr.number,
		owner: pr.base.repo.owner.login,
		repo: pr.base.repo.name,
		body: comment
	})
}

// Sets git remote to use the credentials for the Sportsbot github app
// This allows us to give it write permission to master
async function setGitRemoteToAppPermission(): Promise<void> {
	const appId = core.getInput("appId", { required: true })
	const appKey = core.getInput("appKey", { required: true })
	core.setSecret(appKey)
	const repoSlug = env("GITHUB_REPOSITORY")
	const repoDir = env("GITHUB_WORKSPACE")
	const jwt = generateJwt(appKey, appId)
	const jwtOctokit = new Octokit({
		auth: `Bearer ${jwt}`
	})
	const installation = await getInstallationFromGitHub(jwtOctokit, repoSlug)
	const accessToken = await newAccessTokenFromGitHub(jwtOctokit, installation.id)
	core.setSecret(accessToken.token)
	const remoteURL = gitRemote(accessToken.token, repoSlug)
	await git.setRemote(repoDir, "origin", remoteURL)
}

type MergeMethod = "merge" | "squash" | "rebase"
async function tryMerge(
	octokit: Octokit,
	pr: PullRequestExtended,
	mergeMethod: MergeMethod,
	commitMessage: string | undefined
) {
	async function mergePR() {
		try {
			const res = await octokit.pulls.merge({
				owner: pr.head.repo.owner.login,
				repo: pr.head.repo.name,
				pull_number: pr.number,
				commit_message: commitMessage,
				sha: pr.head.sha,
				merge_method: mergeMethod
			})
			if (res.status === 200) {
				return true
			} else {
				logger.info("Failed to merge PR:", res.status)
				return false
			}
		} catch (e) {
			logger.info("Failed to merge PR:", e.message)
			return false
		}
	}
	return retry(3, 10000, mergePR, mergePR, () => Promise.resolve(false))
}

// PRs to releases/* and to release-* need to be automatically merged
// back to master, or have the PR marked as not ready if there's some kind
// of conflict to master.
async function checkRollupToMaster(octokit: Octokit, pr: PullRequestExtended): Promise<boolean> {
	const repoDir = env("GITHUB_WORKSPACE")
	const context = "Sportsbot: release to master automerge"
	let mergeMsg = await git.canMergeCleanly(repoDir, "master", pr.head.ref)
	const existingStatuses = await octokit.repos.listStatusesForRef({
		ref: pr.head.sha,
		owner: pr.base.repo.owner.login,
		repo: pr.base.repo.name
	})
	const myStatuses = existingStatuses.data.filter(s => s.context === context)
	let needsComment = true
	if (myStatuses.length > 1) {
		if (myStatuses[0].state === "failure" || myStatuses[0].state === "error") {
			needsComment = false
		}
	}
	if (mergeMsg !== null) {
		const desc = "Cannot merge into `master`. Git output:\n\n```" + mergeMsg + "```"
		if (needsComment) {
			await addCommentToPR(octokit, pr, desc)
		}
		await octokit.repos.createStatus({
			sha: pr.head.sha,
			owner: pr.base.repo.owner.login,
			repo: pr.base.repo.name,
			state: "failure",
			description: desc,
			context
		})
		return false
	}
	return true
}

// PRs to master should be automatically merged using the correct merge method
// when they are ready, if they are labelled as needing an automerge.
async function automerge(octokit: Octokit, pr: PullRequestExtended): Promise<void> {
	let mergeMethod: MergeMethod = "merge"
	let title: string | undefined = undefined
	if (pr.base.ref === "master") {
		mergeMethod = "squash"
		title = `${pr.title} (#${pr.number})`
	}

	if (isMergingIntoRelease(pr)) {
		await setGitRemoteToAppPermission()
		const canMerge = await checkRollupToMaster(octokit, pr)
		if (!canMerge) {
			// abort
			return
		}
		// Merge into release first...
		if (!tryMerge(octokit, pr, mergeMethod, title)) {
			throw "Merge failed"
		}
		// Merge and push to master
		const repoDir = env("GITHUB_WORKSPACE")
		const mergeMsg = await git.merge(repoDir, "master", pr.head.ref)
		if (mergeMsg !== null) {
			logger.error(`Automerge from release to master failure: ${mergeMsg}`)
		}
		await git.push(repoDir, false, "master")
		return
	}
	// Is a feature branch into master -- merge
	if (!tryMerge(octokit, pr, mergeMethod, title)) {
		throw "Merge failed"
	}
}

run()
