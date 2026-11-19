"""金额工具：全程使用 Python int（任意精度）表示最小单位（10^-6），零浮点。"""

import re

DECIMALS = 6
SCALE = 10**DECIMALS
_AMOUNT_RE = re.compile(r"^\d+(\.\d{1,6})?$")


def parse_amount(value) -> int | None:
    """
    解析用户输入的金额字符串。
    - 必须 > 0
    - 最多 6 位小数
    - 不接受科学计数法、正负号、空白、空小数部分
    返回最小单位的 int，非法输入返回 None。
    """
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not _AMOUNT_RE.match(s):
        return None
    whole, _, frac = s.partition(".")
    frac_padded = (frac + "0" * DECIMALS)[:DECIMALS]
    result = int(whole) * SCALE + int(frac_padded if frac_padded else "0")
    return result if result > 0 else None


def format_min_unit(value: int) -> str:
    """最小单位转回人类可读字符串（去除尾部无意义的 0）"""
    whole, frac = divmod(int(value), SCALE)
    if frac == 0:
        return str(whole)
    frac_str = str(frac).rjust(DECIMALS, "0").rstrip("0")
    return f"{whole}.{frac_str}"
