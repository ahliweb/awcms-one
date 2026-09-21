🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](SUPPORT.id.md)

# Support

## What this channel is NOT

**This repo holds the code and documentation for re-platforming borneojek-mart, not its live storefront or customer support.** There is no live production deployment of this platform yet — see [`docs/deployment.md`](docs/deployment.md) and [`SECURITY.md`](SECURITY.md) for exactly what is and is not provisioned — and even once there is, a customer's order, payment, or account issue on the running store is not something this repository's issue tracker handles.

Questions about the code, the workspace, the re-platform's scope, or integration with `apps/cms` are welcome through GitHub Issues.

## What can be helped with here

| Need | Route |
| --- | --- |
| A broken gate, a wrong CI result, a workspace that does not build | Open an issue with the **Bug report** template |
| A question about this repo's structure, its gates, or the subtree embed of `apps/cms` | Open an issue; start from [`AGENTS.md`](AGENTS.md) |
| A question about the re-platform's scope for the current increment | See [issue #1](https://github.com/ahliweb/awcms-one/issues/1) first, then open an issue if it is still unclear |
| Wanting to help translate a governance document's Indonesian mirror | Open an issue, then see [`CONTRIBUTING.md`](CONTRIBUTING.md#translation) |
| Finding a security vulnerability | **Do not open a public issue.** Follow [`SECURITY.md`](SECURITY.md) |
| A live storefront or account issue | Not here — this repository has no live deployment yet; once it does, that channel will be documented here |

## Priority

Handled before anything else: a defect that does not fail any gate but is wrong anyway — a schema field re-expressed with the wrong meaning, a workspace boundary quietly crossed, a document that no longer matches what the code does. Every gate in this repo is written to narrow that gap, but a gate only catches what it was written to catch.
