# Test Fixtures

These fixtures are intentionally minimal and stable for test use.

- `installed/pack.mcpack` contains one minimal resource pack
- `installed/addon.mcaddon` contains one minimal behavior pack and one minimal resource pack
- `worlds/World/` contains matching world registration JSON files

Regenerate them with:

```bash
python tests/fixtures/build_fixtures.py
```
