# Install Yosh locally

Start here to run Yosh on your Mac and connect a host. The developer preview targets Apple Silicon macOS. The package includes its runtime and can manage its own backend.

Mainnet requires an existing RC5-compatible Yosh Mainnet profile, wallet in Keychain, ledger and spending configuration. A fresh installation can use isolated Devnet. Full first-time Mainnet onboarding remains open. See the [macOS App guide](native-app-getting-started.md) for the existing App workflow.

## Install a verified preview package

Use a verified package supplied by the project or [build one below](#build-from-source). Extract the ZIP, then run these commands from the extracted directory:

```sh
./Install.command --dry-run
./Install.command --host codex --host grok
```

The first command previews registration. Use `--host codex`, `--host claude` or `--host grok` to select local hosts. Running the installer without a host selection uses its default detection and registration flow. For the full Codex plugin UI and skills, follow [the host plugin guide](host-plugins.md#codex).

Open a fresh host session and ask it to show your Yosh statement. The first read from a newly registered agent can ask for native confirmation on your Mac. Spending permission is granted separately for an agent and API.

For an upgrade, follow the [runtime handoff instructions](../architecture/mainnet-standalone-runtime-20261113.md). The service verifies the installed runtime, waits for active operations to finish and checks ownership before switching. The package and any host entries that pin its runtime must stay in sync.

## Build from source

Building requires Apple Silicon macOS, Node.js 24.5+, npm, Python 3.9+, Rust/Cargo and Xcode build tools. Use the pinned [dependency build procedure](../architecture/codex-plugin-dev.md#reproducible-build) and a verified [MPP protocol artifact](../architecture/mpp-solana-charge.md).

From the repository root, run:

```sh
python3 -B scripts/build-standalone-dependencies.py verify \
  --output build.noindex/standalone-dependencies
python3 -B scripts/build-standalone-dev.py \
  --dependencies build.noindex/standalone-dependencies \
  --local-authorization --mainnet-mpp --mpp-artifact /path/to/verified-mpp-artifact \
  --output build.noindex/plugin-runtime
python3 -B scripts/package-standalone-plugin.py \
  --runtime-package build.noindex/plugin-runtime \
  --output build.noindex/plugin-package
```

The verify command checks previously built dependencies. The packager writes a local marketplace directory, ZIP and checksum evidence in `build.noindex/plugin-package/`. Installation and Mainnet configuration are separate steps after the build.

[Back to Yosh](../../README.md)
