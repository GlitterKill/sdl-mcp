"""Python test fixture for import extraction (ML-C1.2)"""

# Simple import
import os
import sys

# Import with alias
import numpy as np
import pandas as pd

# From import
from typing import List
from typing import Dict, Optional
from typing import Union, Any, Callable

# From import with alias
from typing import List as TypingList
from collections import defaultdict as dd

# Wildcard import
from math import *
from typing import *

# Relative import
from . import module
from .. import parent_module
from ... import grandparent_module

# Relative import with specific names
from .utils import helper_function
from ..config import Config, Settings
from .types import MyType as MT

# Absolute import from package
from my_package import ClassA
from my_package.submodule import ClassB, function_b

# Import from standard library (not external)
import json
import re
import datetime

# Multi-line import
from typing import (
    List,
    Dict,
    Optional,
    Union,
)

# Import nested module
from package.submodule.subsub import thing

# Relative import with alias
from .module import MyClass as MC
