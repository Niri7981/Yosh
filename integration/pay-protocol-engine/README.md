This internal helper calls the preserved Rust pay/pay-kit protocol code. It has no
signer, wallet, Ledger or paid HTTP operation. Its only network targets are numeric
loopback HTTP; it refuses credentials, redirects, unbounded bodies and other
networks/assets/schemes. This Rust binary and its fork dependencies are built only
by the explicit isolated script; they are not bundled into the installed App.

Build (macOS, explicit preserved dependency):

```sh
python3 scripts/build-pay-protocol-engine.py --archive /Users/irin/Desktop/open-source/yosh-pay-integration-poc --test
python3 integration/pay-protocol-engine/check-hostile-challenges.py
```

Output: `build.noindex/pay-protocol-engine/yosh-execution-protocol`.
The build verifies consumed sources/vendor files against the archive's SHA256
manifest, copies the fork sources, and uses `--offline --locked`, an empty local
Cargo home, and OS denial of network, Keychain and production data. The archive,
original pay checkout and Yosh dependency lock remain untouched. Generated
provenance records include archive manifest, wrapper and binary hashes.

One JSON request on stdin, one JSON response on stdout, then process exit:

- `{"operation":"quote","url":"http://127.0.0.1:PORT/resource","method":"GET","headers":{}}`
  returns `{ok,challenge,requirement,classifier}`. Only Accept/Content-Type request
  headers are accepted; POST can include a raw string `body` (16 KiB maximum).
- `{"operation":"prepare","payer":"PUBLIC_KEY","rpcUrl":"http://127.0.0.1:PORT/rpc","requirement":ACCEPTED}`
  returns `{ok,transaction,recentBlockhash,lastValidBlockHeight}`. Transaction
  signatures are zero; height is a decimal string. A bounded fake RPC call supplies
  the blockhash; the real SDK unsigned builder performs construction. A different
  challenge blockhash is rejected.
- `{"operation":"interpret","status":200,"headers":{"payment-response":"RECEIPT"}}`
  returns `{ok,receipt,repeatedPaymentRequired}`. Receipt contains only success,
  network and optional payer observations; it proves no economic
  result. Yosh must independently reconcile its saved original transaction.

Failures return `{ok:false,error:STABLE_CODE}` with no raw exception or request.

Fork provenance: pay 0.30.0 at `df57843e1f728fcc8ff8e42db78e0ad99372cd9d`,
pay-kit 0.10.0 at `f8ef055b1d1c8ca8245f19bbca819faed9cfa058` plus the preserved
additive `exact::prepare_unsigned_payment` patch. Actual source hashes are verified;
these commit IDs alone do not identify the patched snapshot. Solana-keychain is
vendored at `44b479df245167ca3b3a4e04d6d907146306d342`; its signing paths are never
invoked by this wrapper.

The pinned pay-core classifier prefers Mainnet when offered and recognizes
Devnet-only fixtures through its SDK selector. The returned `classifier` is
`pay-core`. Both networks accept only Solana x402 V2 exact native USDC
(6 decimals), and reject extensions. There is no fallback to pay's signer or
free paid-fetch path. The old PoC Gate and Mock Grant/Ledger are not used here.
Unsupported paymentFlow/assetTransferMethod, foreign token programs, invalid memo,
timeout, fee payer and noncanonical alias terms are refused before construction.
The standalone hostile-challenge check invokes actual quote/prepare subprocesses
with fresh loopback services under OS network/production-state isolation.
