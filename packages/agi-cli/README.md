# @phnx-labs/agi-cli — deprecated alias

> **Deprecated.** Install the canonical package instead:
>
> ```bash
> npm install -g @phnx-labs/agents-cli
> ```
>
> The canonical package is **[`@phnx-labs/agents-cli`](https://www.npmjs.com/package/@phnx-labs/agents-cli)**.

This package exists only as a thin front-brand alias of `@phnx-labs/agents-cli`. Installing it gives you the exact same tool, exposed as three interchangeable commands: `agents`, `ag`, and `agi`. It is kept published so existing `@phnx-labs/agi-cli` installs keep working, but it lags the canonical package and receives no independent development.

New installs and all documentation should use `@phnx-labs/agents-cli`. If you already installed this alias, nothing breaks — but prefer the canonical package going forward:

```bash
npm uninstall -g @phnx-labs/agi-cli
npm install -g @phnx-labs/agents-cli
```

Docs and source: <https://github.com/phnx-labs/agents-cli>

Apache-2.0 © Phoenix Labs
