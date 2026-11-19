"""Python 后端自测：金额/校验/幂等/6 场景/防重放/状态分离。

用 DB_PATH=:memory: 运行：DB_PATH=:memory: pytest -q
"""
import os

os.environ.setdefault("DB_PATH", ":memory:")

import pytest  # noqa: E402

from app.config import CONFIG  # noqa: E402
from app import service  # noqa: E402
from app.money import parse_amount, format_min_unit  # noqa: E402
from app.validation import validate_create_body  # noqa: E402
from app.errors import AppError  # noqa: E402

ACCOUNT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
NETWORK = CONFIG["chainId"]
TOKEN = CONFIG["token"]["address"]
R1 = "0x1111111111111111111111111111111111111111"
R2 = "0x2222222222222222222222222222222222222222"

_counter = [0]


def make(scenario="SUCCESS", recipients=None):
    _counter[0] += 1
    return {
        "requestId": f"py-{os.getpid()}-{_counter[0]}",
        "chainId": NETWORK,
        "fromAddress": ACCOUNT,
        "tokenAddress": TOKEN,
        "scenario": scenario,
        "recipients": recipients or [{"address": R1, "amount": "1.5"}, {"address": R2, "amount": "2.25"}],
    }


def must_fail(fn, code):
    with pytest.raises(AppError) as ei:
        fn()
    assert ei.value.code == code


@pytest.fixture(autouse=True)
def reset():
    service.reset_chain()
    db = service.db
    db.execute("DELETE FROM txs")
    db.execute("DELETE FROM batches")
    db.commit()


def approve_confirmed(batch_id):
    service.submit_approve(batch_id, ACCOUNT, NETWORK)
    service.recheck(batch_id, "APPROVE")


class TestMoney:
    def test_parse_and_format(self):
        assert parse_amount("1") == 1_000_000
        assert parse_amount("0.000001") == 1
        assert parse_amount("123.456789") == 123_456_789
        assert format_min_unit(123_456_789) == "123.456789"
        assert format_min_unit(1) == "0.000001"
        for bad in ["", "0", "-1", "1.1234567", "1e3", "abc", ".5", "1.", "+1"]:
            assert parse_amount(bad) is None

    def test_no_float_drift(self):
        assert parse_amount("0.1") + parse_amount("0.2") == 300_000


class TestValidation:
    def test_case_insensitive_duplicate(self):
        mixed = "0xABAbABAbABAbABAbABAbABAbABAbABAbABAbABAb"
        ok, errs = validate_create_body(make(recipients=[
            {"address": mixed, "amount": "1"},
            {"address": mixed.lower(), "amount": "2"},
        ]))
        assert ok is False
        assert any(e["field"] == "address" and "重复" in e["message"] for e in errs)

    def test_zero_addr_and_bad_amount_rows(self):
        ok, errs = validate_create_body(make(recipients=[
            {"address": "0x" + "0" * 40, "amount": "1"},
            {"address": ACCOUNT, "amount": "1.1234567"},
        ]))
        assert ok is False
        assert any(e["row"] == 1 and "零地址" in e["message"] for e in errs)
        assert any(e["row"] == 2 and e["field"] == "amount" for e in errs)

    def test_fixed_token(self):
        ok, _ = validate_create_body({**make(), "tokenAddress": "0x" + "3" * 40})
        assert ok is False


class TestIdempotency:
    def test_same_content_reuse_and_conflict(self):
        body = make()
        first = service.create_batch(body)
        second = service.create_batch(body)
        assert second["reused"] is True
        assert second["batch"]["id"] == first["batch"]["id"]
        must_fail(lambda: service.create_batch({**body, "scenario": "TRANSFER_REVERT"}), "IDEMPOTENCY_CONFLICT")

    def test_normalized_total(self):
        b = service.create_batch(make())["batch"]
        assert b["totalMinUnit"] == "3750000"
        assert b["totalDisplay"] == "3.75"


class TestScenarios:
    def test_success(self):
        bid = service.create_batch(make("SUCCESS"))["batch"]["id"]
        assert service.preflight(bid, ACCOUNT, NETWORK)["needsApproval"] is True
        approve_confirmed(bid)
        assert service.get_batch(bid)["txs"][0]["status"] == "CONFIRMED"
        assert service.get_batch(bid)["status"] == "AWAITING_WALLET"
        service.submit_transfer(bid, ACCOUNT, NETWORK)
        assert service.get_batch(bid)["status"] == "SUBMITTED_PENDING"
        service.recheck(bid, "TRANSFER")
        assert service.get_batch(bid)["status"] == "CONFIRMED"

    def test_approve_rejected(self):
        bid = service.create_batch(make("APPROVE_REJECTED"))["batch"]["id"]
        service.submit_approve(bid, ACCOUNT, NETWORK)
        assert service.recheck(bid, "APPROVE")["tx"]["status"] == "REJECTED"
        must_fail(lambda: service.submit_transfer(bid, ACCOUNT, NETWORK), "APPROVE_NOT_CONFIRMED")

    def test_transfer_revert(self):
        bid = service.create_batch(make("TRANSFER_REVERT"))["batch"]["id"]
        approve_confirmed(bid)
        service.submit_transfer(bid, ACCOUNT, NETWORK)
        assert service.recheck(bid, "TRANSFER")["tx"]["status"] == "FAILED"
        assert service.get_batch(bid)["status"] == "FAILED"

    def test_query_timeout(self):
        bid = service.create_batch(make("QUERY_TIMEOUT"))["batch"]["id"]
        approve_confirmed(bid)
        service.submit_transfer(bid, ACCOUNT, NETWORK)
        assert service.recheck(bid, "TRANSFER")["tx"]["status"] == "UNCERTAIN"
        must_fail(lambda: service.submit_transfer(bid, ACCOUNT, NETWORK), "TRANSFER_IN_FLIGHT")
        assert service.recheck(bid, "TRANSFER")["tx"]["status"] == "CONFIRMED"

    def test_double_submit_blocked(self):
        bid = service.create_batch(make("SUCCESS"))["batch"]["id"]
        approve_confirmed(bid)
        service.submit_transfer(bid, ACCOUNT, NETWORK)
        must_fail(lambda: service.submit_transfer(bid, ACCOUNT, NETWORK), "TRANSFER_IN_FLIGHT")
        assert len([t for t in service.get_batch(bid)["txs"] if t["type"] == "TRANSFER"]) == 1

    def test_account_and_network_change(self):
        bid = service.create_batch(make("ACCOUNT_CHANGED"))["batch"]["id"]
        must_fail(lambda: service.preflight(bid, ACCOUNT, NETWORK), "ACCOUNT_CHANGED")
        must_fail(lambda: service.submit_approve(bid, ACCOUNT, NETWORK), "ACCOUNT_CHANGED")
        bid2 = service.create_batch(make("SUCCESS"))["batch"]["id"]
        must_fail(lambda: service.preflight(bid2, ACCOUNT, "1"), "NETWORK_CHANGED")

    def test_insufficient_balance(self):
        huge = [{"address": "0x" + hex(i + 1)[2:].rjust(40, "0"), "amount": "999999"} for i in range(20)]
        bid = service.create_batch(make("INSUFFICIENT_BALANCE", huge))["batch"]["id"]
        assert service.preflight(bid, ACCOUNT, NETWORK)["sufficientBalance"] is False

    def test_approve_and_transfer_separate(self):
        bid = service.create_batch(make("SUCCESS"))["batch"]["id"]
        approve_confirmed(bid)
        service.submit_transfer(bid, ACCOUNT, NETWORK)
        txs = service.get_batch(bid)["txs"]
        ap = next(t for t in txs if t["type"] == "APPROVE")
        tr = next(t for t in txs if t["type"] == "TRANSFER")
        assert ap["txHash"] != tr["txHash"]
        assert ap["status"] == "CONFIRMED" and tr["status"] == "PENDING"
