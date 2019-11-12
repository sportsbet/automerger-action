# automerger-action

A GitHub action that implements Sportsbet's merge rules to automatically merge
branches. :rocket:

## Usage

Note: This code is intended for use by a specific internal repository in Sportsbet.
While it may be useful to others, it is not designed to be generic. We do not
recommend its use, provide no support, no warranty, and probably will not accept
pull requests. See LICENSE for more.

The bot will _only_ pick up on PRs that have the label `Automerge`. All other
PRs will be ignored until they have this label. Simply add the `Automerge`
label to your PR when you're ready for it to be automatically merged.

The bot will pick up when the PR is ready to merge, and if it has the label,
will automatically merge the PR with the correct merge strategy.

Merge strategy determined like this:

-   PR from `*` to `master`: Squash
-   PR from `*` to `release-web` or `release-ios` or `releases/*`: Merge
-   Otherwise: Merge

Note that the bot has special behaviour when raising a PR into `release-web`,
`release-ios`, and `releases/*`. Any PRs into these branches, when merged,
will also _automatically_ be merged into `master`. If the branch specified
in the PR cannot be cleanly merged into `master`, it will put a failed status
check on your PR, preventing its merge, until it can be cleanly merged into
`master`.

## Installing

Create a new `.git/workflows/automerger-action.yml`:

```yaml
name: automerger
on:
  pull_request:
  types:
    - labeled
  pull_request_review:
  types:
    - submitted
jobs:
  automerge:
  runs-on: ubuntu-latest
  steps:
    - name: automerge
    uses: "Sportsbet/automerger-action@master"
    with:
      githubToken: "${{ secrets.GITHUB_TOKEN }}"
      appId: "${{ secrets.APP_ID }}"
      appKey: "${{ secrets.APP_KEY }}"
```

In your GitHub repository, go to Settings - Secrets and add a new secret called
`APP_KEY` and put the private key for the [GitHub App](https://developer.github.com/apps/)
that has write permission to `master` in there.

## Developing

Be careful since any commits to `master` here will affect ongoing PRs in
repositories that use this.

This project does some things that are not very JavaScripty, such as having
the `node_modules` checked in, and needing to pre-compile to js _before_
committing, and then comitting the resulting js. This is just because of how
GitHub Actions work, don't question it too much.

Just keep in mind, before every commit:

-   run `npm install`
-   run `npm run build`
-   run `npm ci --production`
