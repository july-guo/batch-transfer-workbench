"""
模拟链适配器。与 Node 版行为一致：
- 提交交易只返回 txHash，状态恒为 PENDING
- 成功只能来自 query_transaction 返回值，客户端无法自行声明成功
- 不同场景独立触发
"""

import hashlib
import time
import random

from ..config import CONFIG


class MockChain:
    def __init__(self):
        self.reset()

    def reset(self):
        self.balance = int(CONFIG["initialBalanceMinUnit"])
        self.allowances: dict[str, int] = {}
        self.ledger: dict[str, dict] = {}

    @staticmethod
    def _allowance_key(owner: str, spender: str) -> str:
        return f"{owner.lower()}->{spender.lower()}"

    def get_balance(self, _address: str) -> int:
        return self.balance

    def get_allowance(self, owner: str, spender: str) -> int:
        return self.allowances.get(self._allowance_key(owner, spender), 0)

    def submit_transaction(self, tx_type: str, scenario: str, payload_hash: str) -> dict:
        raw = f"{payload_hash}:{tx_type}:{time.time_ns()}:{random.random()}"
        tx_hash = "0x" + hashlib.sha256(raw.encode()).hexdigest()
        outcome, reason = "CONFIRMED", None
        if scenario == "APPROVE_REJECTED" and tx_type == "APPROVE":
            outcome, reason = "REJECTED", "用户在钱包中拒绝了授权"
        elif scenario == "TRANSFER_REVERT" and tx_type == "TRANSFER":
            outcome, reason = "FAILED", "批量转账交易回滚（execution reverted）"
        self.ledger[tx_hash] = {"outcome": outcome, "reason": reason}
        return {"txHash": tx_hash, "status": "PENDING"}

    def query_transaction(self, tx_hash: str, tx_type: str, scenario: str, recheck_count: int) -> dict:
        record = self.ledger.get(tx_hash)
        if not record:
            return {"status": "UNCERTAIN", "reason": "模拟链中未找到该交易哈希"}
        if scenario == "QUERY_TIMEOUT" and tx_type == "TRANSFER" and recheck_count == 0:
            return {"status": "UNCERTAIN", "reason": "查询超时：节点暂未返回回执，链上结果未知"}
        return {"status": record["outcome"], "reason": record["reason"]}

    @staticmethod
    def current_account(expected: str, scenario: str) -> str:
        if scenario == "ACCOUNT_CHANGED":
            return "0x9999999999999999999999999999999999999999"
        return expected

    def apply_allowance(self, owner: str, spender: str, amount: int):
        """授权确认后按 approve 语义覆盖为本次所需额度"""
        self.allowances[self._allowance_key(owner, spender)] = amount
