# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 - 2026-06-16

### Added

- Initial release of open-fusions: a local model-fusion engine that fans prompts across a panel, judges consensus and blind spots, then synthesizes a final answer.
- Durable plan -> implement -> review -> fix coding loop where every phase is a fusion.
- CLI (`open-fusions`) and programmatic APIs (`fuse`, `fuseWith`, `OpenFusionsEngine`) powered by smithers + incur, using the user's own subscription agents by default.
