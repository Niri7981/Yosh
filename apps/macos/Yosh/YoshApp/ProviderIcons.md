# Members provider icons

All marks remain the property of their respective owners and identify the listed agents.
They are bundled as SVG images in `ProviderIcons.xcassets` and preserve vector
representation. Template marks use the roster's existing ink color; Cursor retains
its official white/gray faces so the interior shape remains visible. No runtime
network fetch is needed.

| Agent | Mark and source |
| --- | --- |
| Codex | OpenAI `OpenAI-black-monoblossom.svg`, unchanged from [official logo pack](https://cdn.openai.com/brand/OpenAI-Logos-2025.zip), linked by [OpenAI brand guidelines](https://openai.com/brand/). |
| Claude Code | `Claude Spark - Clay.svg`, unchanged from [Anthropic's official press kit](https://anthropic.com/press-kit). |
| Gemini CLI | Exact silhouette path from [Google's Gemini SVG](https://www.gstatic.com/lamda/images/gemini_sparkle_aurora_33f86dc0c0257da337c63.svg), used by [Gemini](https://gemini.google.com/). The color texture and embedded JPEG are omitted for a purely vector, monochrome template. |
| Grok | Grok logomark from the [Lobe Icons SVG mirror](https://github.com/lobehub/lobe-icons/blob/master/packages/static-svg/icons/grok.svg). The [official resource pack](https://data.x.ai/logos/xAI_Grok_Assets.zip) linked by [xAI brand guidelines](https://x.ai/legal/brand-guidelines) returned HTTP 403 during retrieval. Only template fill, SVG dimensions, and browser-only styling were normalized; the path is unchanged. Mirror license: `ProviderIcons-LICENSE.txt`. |
| Cursor Agent | `General Logos/Cube/SVG/CUBE_25D.svg`, unchanged from [Cursor's official brand assets](https://ptht05hbb1ssoooe.public.blob.vercel-storage.com/assets/brand/cursor-brand-assets.zip), linked by [Cursor's brand page](https://cursor.com/brand). Original grayscale rendering preserves all five faces. SHA-256: `b988bb319a68358fd4ba751ab3813e82c8bb04e6c2f2ed913889a9b621471b14`. |
| GitHub Copilot | `GitHub Logos/SVG/GitHub_Invertocat_Black.svg`, unchanged from [GitHub's official logo pack](https://brand.github.com/GitHub_Logos.zip), linked by [GitHub's logo guidelines](https://brand.github.com/foundations/logo). The official Octocat silhouette (Invertocat) uses template rendering. SHA-256: `693d7abe6f899646cc2e96856723b45e95f71885a54910b2749f6decdf7e1ee1`. |

The different image frames account for the OpenAI asset's built-in clear space
and the other marks' silhouettes. All images scale proportionally inside the
unchanged 44 × 44 roster containers. Custom agents retain their existing icon.

## Activity payment network

`NetworkSolana` uses the unchanged official gradient logomark from
[Solana brand assets](https://solana.com/branding), downloaded from
`https://solana.com/src/img/branding/solanaLogoMark.svg`. It renders in its original
colors on an independent black circle; there is no runtime image loading.
