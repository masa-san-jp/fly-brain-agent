# Humanoid avatar assets

`HumanoidRenderer` first looks for `public/avatars/AvatarSample_A.vrm` (served as
`avatars/AvatarSample_A.vrm`). To use the official VRoid sample, download/export
AvatarSample_A through VRoid Studio or VRoid Hub and place the file at exactly:

```text
public/avatars/AvatarSample_A.vrm
```

The current official conditions say that AvatarSample_A is usable for commercial
and non-commercial activity without attribution, but it is **not CC0** and its
VRM file may not be redistributed as CC0. Source and conditions:

- https://vroid.pixiv.help/hc/en-us/articles/4402394424089-VRoidPreset-A-Z
- https://hub.vroid.com/en/characters/2843975675147313744/models/5644550979324015604

The non-interactive VRoid Hub download flow was attempted for this checkout but
requires the Hub/terms flow (the direct preview API returned HTTP 400). Therefore
the checked-in fallback is:

`VRM1_Constraint_Twist_Sample.vrm`

- Source: https://github.com/pixiv/three-vrm/tree/release/packages/three-vrm-animation/examples/models
- Direct source: https://raw.githubusercontent.com/pixiv/three-vrm/release/packages/three-vrm-animation/examples/models/VRM1_Constraint_Twist_Sample.vrm
- Embedded metadata: author `pixiv Inc.`, copyright `(c) 2022 pixiv Inc.`, VRM License 1.0 at https://vrm.dev/licenses/1.0/
- Embedded permissions: redistribution and modification allowed; attribution marked unnecessary; this model is not treated as MIT merely because the source repository code is MIT.
- SHA-256: `12c2b97e95e700783a6a550dc0eee2d7880aeedccef9ae67bc4c5a2f0f2631a2`

The fallback is used automatically when `AvatarSample_A.vrm` is absent, so
`arena.html?avatar=vrm` remains runnable in a clean checkout.
