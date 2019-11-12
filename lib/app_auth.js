"use strict";
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const jwt = __importStar(require("jsonwebtoken"));
const endpoint_1 = require("@octokit/endpoint");
function timeNow() {
    return Math.floor(new Date().getTime() / 1000);
}
function tenMinutesFromNow() {
    return Math.floor(new Date().getTime() / 1000) + 600;
}
function generateJwt(key, appId) {
    const payload = {
        iat: timeNow(),
        exp: tenMinutesFromNow(),
        iss: appId
    };
    return jwt.sign(payload, key, { algorithm: "RS256" });
}
exports.generateJwt = generateJwt;
// repoSlug is the owner/repo-name
// E.g. microsoft/typescript
async function getInstallationFromGitHub(jwtOctokit, repoSlug) {
    const parts = repoSlug.split("/");
    const installation = await jwtOctokit.apps.getRepoInstallation({ owner: parts[0], repo: parts[1] });
    const thing = endpoint_1.endpoint("GET /repos/:owner/:repo/installation", {
        headers: {
            authorization: `Bearer ${jwt}`
        },
        owner: parts[0],
        repo: parts[1]
    });
    return installation.data;
}
exports.getInstallationFromGitHub = getInstallationFromGitHub;
async function newAccessTokenFromGitHub(jwtOctokit, installationId) {
    const token = await jwtOctokit.apps.createInstallationToken({
        installation_id: installationId
    });
    return token.data;
}
exports.newAccessTokenFromGitHub = newAccessTokenFromGitHub;
function gitRemote(accessToken, repoSlug) {
    return `https://x-access-token:${accessToken}@github.com/${repoSlug}.git`;
}
exports.gitRemote = gitRemote;
