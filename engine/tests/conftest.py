import shutil
import subprocess
import sys

import pytest

from helpers import MEDIA, ROOT


@pytest.fixture(scope="session", autouse=True)
def test_media():
    if not (MEDIA / "noisy.mp4").exists():
        subprocess.run([sys.executable, str(ROOT / "scripts" / "make_test_media.py")], check=True)
    return MEDIA


@pytest.fixture
def workdir(tmp_path, test_media):
    """Copy test media into a temp folder so outputs don't accumulate."""
    def copy(*names):
        out = []
        for n in names:
            dst = tmp_path / n
            shutil.copy2(test_media / n, dst)
            out.append(dst)
        return out if len(out) > 1 else out[0]
    return copy
