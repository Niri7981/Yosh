# Install Yosh locally

Start here to run Yosh on your Mac and connect a host. The developer preview targets Apple Silicon macOS. The package includes its runtime and can manage its own backend.

Mainnet requires an existing RC5-compatible Yosh Mainnet profile, wallet in Keychain, ledger and spending configuration. A fresh installation can use isolated Devnet. Full first-time Mainnet onboarding remains open. See the [macOS App guide](native-app-getting-started.md) for the existing App workflow.

## Install a verified preview package

On Apple Silicon macOS, run the versioned installer in Terminal:

```sh
curl -fsSL https://github.com/Niri7981/Yosh/releases/download/v0.2.20-preview/install-yosh.sh -o install-yosh.sh && /bin/sh install-yosh.sh
```

It downloads the preview ZIP, verifies its SHA-256 and keeps the extracted marketplace in the Yosh Preview folder under your macOS Application Support directory. Then it opens the host menu.

If you already have a verified ZIP or [build a package locally](#build-from-source), open the installer from its extracted directory:

```sh
./Install.command --interactive
```

Enter the numbers beside the installed hosts you want to connect and type `done`. Choosing Dot shows the [separate ChatGPT tunnel setup](host-plugins.md#dot-in-chatgpt). Pass `--dry-run --interactive` to preview your selection, or use `--host codex`, `--host claude` and `--host grok` for scripted installs. Running the installer without a host selection uses its default detection and registration flow. For the full Codex plugin UI and skills, follow the [Codex guide](host-plugins.md#codex).

Open a fresh host session and ask it to show your Yosh statement. The first read from a newly registered agent can ask for native confirmation on your Mac. Spending permission is granted separately for an agent and API.

### Start in Devnet on a fresh Mac

The registered first-use tools open the existing Mainnet account. On a fresh Mac, start the independent Devnet setup from the extracted package:

```sh
./plugins/yosh-local-dev/yosh-dev settings
```

Open the local setup URL returned by Yosh. Choose Devnet and follow the wallet setup flow. The Devnet wallet, permissions and ledger are isolated from Mainnet.

### Upgrade a preview

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
