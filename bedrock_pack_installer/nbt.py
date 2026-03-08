import io
import shutil
import struct
from pathlib import Path


def enable_beta_apis(dat_path: Path) -> bool:
    import nbtlib

    with open(dat_path, "rb") as f:
        header = f.read(8)
        version, _ = struct.unpack("<II", header)
        nbt_data = f.read()

    nbt_file = nbtlib.File.parse(io.BytesIO(nbt_data), byteorder="little")

    if "experiments" not in nbt_file:
        nbt_file["experiments"] = nbtlib.Compound()

    experiments = nbt_file["experiments"]
    current_beta = experiments.get("gametest", nbtlib.Byte(0))
    if int(current_beta) == 1:
        return False

    shutil.copy2(dat_path, dat_path.with_suffix(".dat.backup"))

    experiments["data_driven_items"] = nbtlib.Byte(1)
    experiments["gametest"] = nbtlib.Byte(1)
    experiments["experiments_ever_used"] = nbtlib.Byte(1)
    experiments["saved_with_toggled_experiments"] = nbtlib.Byte(1)

    buf = io.BytesIO()
    nbt_file.write(buf, byteorder="little")
    nbt_bytes = buf.getvalue()

    with open(dat_path, "wb") as f:
        f.write(struct.pack("<II", version, len(nbt_bytes)))
        f.write(nbt_bytes)

    return True
