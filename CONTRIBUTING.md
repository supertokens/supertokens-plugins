# Contributing to SuperTokens Plugins

## Project Organization

This repository is organized as a monorepo using Turborepo and npm workspaces. The structure is as follows:

### Directory Structure

- **`packages/`** - Plugins/Packages which get published
- **`shared/`** - Shared utilities and configurations

## Add New Plugins

When creating a new plugin, follow these steps:

1. Create new folders in the `packages` directory based on the following convention: `{plugin-name}-{language/framework}`
2. Add a `package.json` file to each new plugin folder.
   In the file make sure to cover the following fields:

- `name` - The name of the plugin.
- `version` - The version of the plugin. This will get updated automatically by the release workflow.
- `exports` - Files that get exported by the plugin
- `build` - The command that will be run to build the plugin

Additionally, if you import anything from the `shared` folder, make sure to include it in either `dependencies` or `devDependencies`.

## Release Process

This project uses [Changesets](https://github.com/changesets/changesets) for version management and publishing.

### Generating change files

Every time you make changes that should trigger version bumps run the changeset command:

```bash
npm run changeset
```

This will prompt you to:

1. Select which packages are affected
2. Choose the type of change (major, minor, patch)
3. Write a summary of the changes

In the end, a unique file will be generated in the `.changeset` directory with your change summary.

### Release workflow

Everytime something gets merged to the main branch, a PR will be created/updated, from the CI.
The PR relies on the `npm run version` command to update package versions and changelogs.

Publishing to NPM can be triggered manually, from the CI, using the `public-release` workflow.
The workflow run is conditioned by an approval from one of the admins.

> [!IMPORTANT]  
> If the target branch has unversioned changes, the `public-release` workflow will create a versioning PR instead of publishing.

#### Private versions

If you want to test a new package version directly from NPM you can use the private release workflow.
It will create beta versions of the packages that won't be publicly available on NPM.
