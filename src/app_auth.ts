import * as jwt from "jsonwebtoken"
import { endpoint } from "@octokit/endpoint"
import Octokit from "@octokit/rest"

export interface GitHubAppAccessToken {
	token: string
	expires_at: string
}

function timeNow(): number {
	return Math.floor(new Date().getTime() / 1000)
}

function tenMinutesFromNow(): number {
	return Math.floor(new Date().getTime() / 1000) + 600
}

export function generateJwt(key: string, appId: string): string {
	const payload = {
		iat: timeNow(),
		exp: tenMinutesFromNow(),
		iss: appId
	}
	return jwt.sign(payload, key, { algorithm: "RS256" })
}

// repoSlug is the owner/repo-name
// E.g. microsoft/typescript
export async function getInstallationFromGitHub(
	jwtOctokit: Octokit,
	repoSlug: string
): Promise<Octokit.AppsGetRepoInstallationResponse> {
	const parts = repoSlug.split("/")
	const installation = await jwtOctokit.apps.getRepoInstallation({ owner: parts[0], repo: parts[1] })
	const thing = endpoint("GET /repos/:owner/:repo/installation", {
		headers: {
			authorization: `Bearer ${jwt}`
		},
		owner: parts[0],
		repo: parts[1]
	})
	return installation.data
}

export async function newAccessTokenFromGitHub(
	jwtOctokit: Octokit,
	installationId: number
): Promise<Octokit.AppsCreateInstallationTokenResponse> {
	const token = await jwtOctokit.apps.createInstallationToken({
		installation_id: installationId
	})
	return token.data
}

export function gitRemote(accessToken: string, repoSlug: string) {
	return `https://x-access-token:${accessToken}@github.com/${repoSlug}.git`
}
