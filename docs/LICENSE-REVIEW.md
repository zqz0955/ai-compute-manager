# License and provenance review

AI Compute Manager project-original material that its rightsholders can license is distributed under [Apache-2.0](../LICENSE). This does not relicense third-party software, models, trademarks or services. The project owner states that earlier ACM versions were primarily developed for the project with ChatGPT and Codex, and that the two screenshots were captured from this project; the owner cannot guarantee that historical material contains no third-party content.

| Material | Provenance and distribution |
| --- | --- |
| ACM source, tests, configuration and documentation | Project history includes the earlier ACM source and subsequent project changes. The owner authorizes release of project-original material they can license. File history alone does not prove authorship or rule out third-party material. |
| Dashboard screenshots | Two captured project UI images use simulated devices and work. Their origin was confirmed by the project owner; an earlier independent review also inspected the images. No external stock image or font file is packaged. |
| npm packages | The lockfile contains only the root package; no npm dependency is bundled. The CI checks this inventory. |
| Node.js and SQLite | Separately installed runtime; not included in the source or installation archive. Node.js carries its own license and third-party notices: [24.22.3](https://github.com/nodejs/node/blob/v24.22.3/LICENSE), [22.23.5](https://github.com/nodejs/node/blob/v22.23.5/LICENSE). SQLite is part of the separately installed Node runtime. |
| Ollama and model weights | Not included in the source or installation archive. Ollama is a separately obtained runtime, with its [own license](https://github.com/ollama/ollama/blob/v0.40.16/LICENSE). Model assets and their licenses must be checked independently before acquisition or use. |
| GitHub Actions | CI references, rather than bundles, pinned [checkout](https://github.com/actions/checkout/blob/11bd71901bbe5b1630ceea73d27597364c9af683/LICENSE) and [setup-node](https://github.com/actions/setup-node/blob/49933ea5288caeca8642d1e84afbd3f7d6820020/LICENSE), each under its own MIT license. |
| Chrome, Playwright, Python client libraries | Optional external test or client tools; not bundled. Their respective licenses apply when independently obtained. |

A name or compatibility reference does not transfer rights in another project's code or brand. The package's [SBOM](sbom.cdx.json) lists reference runtime components. Findings of third-party content or missing attribution should be reported through the security or maintainer contact process before redistribution of the affected material.
