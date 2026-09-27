# Humanoid animation assets

`UAL1_Standard.glb` is the free Standard export of Quaternius' Universal
Animation Library. It contains 43 glTF animation clips, including idle, walk,
jog, sprint, crouch, jump and death. The non-`_RM` file is used so root motion
does not fight the fly pose; arena.js owns the humanoid root position and yaw.

- Source/download page: https://quaternius.itch.io/universal-animation-library
- Pack author: Quaternius
- License: CC0 1.0 Universal, as stated in the archive's `License.txt`
- Download archive: `Universal Animation Library[Standard].zip`, obtained through the itch.io anonymous file endpoint
- Checked-in file: `public/animations/UAL1_Standard.glb`
- SHA-256: `69591853d817488edaa8fd9bf8fc1d821eaeaf789f8627b3cd23b41c4ed67997`

To replace it with another UAL-compatible glTF, keep the default path above or
pass a different `animationUrl` to `HumanoidRenderer`. The intended manual
location for a replacement is:

```text
public/animations/UAL1_Standard.glb
```

If the file is absent or cannot be decoded, the renderer uses the procedural
fallback in `src/humanoid/proceduralClips.js` for every state, including the
states that are not present in the free UAL subset (back-walk, rub-face and
fall).
