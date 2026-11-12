"""Shared pytest configuration: add the project root to sys.path so pytest works directly.

Also caps BLAS thread counts before numpy is imported, to avoid pytest-xdist workers
multiplying OpenBLAS threads and causing memory allocation failures.
"""

import os
import sys

for _k in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS",
           "NUMEXPR_NUM_THREADS"):
    os.environ.setdefault(_k, "1")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
