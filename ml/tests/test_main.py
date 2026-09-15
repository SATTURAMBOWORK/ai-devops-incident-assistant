"""
Tests for main.py - the API contract the backend depends on.

The route functions are called directly rather than over HTTP, so no test
client (and no extra dependency) is needed. FastAPI's own validation of the
request body is FastAPI's job to test, not ours.
"""

import unittest

from fastapi import HTTPException

import main
from predict import UNKNOWN_LABEL
from schemas import PredictRequest
from tests.fakes import FakeModel


class WithModel(unittest.TestCase):
    def setUp(self):
        self.addCleanup(main.state.update, {"model": main.state["model"]})


class HealthTest(WithModel):
    def test_reports_degraded_without_a_model(self):
        main.state["model"] = None
        body = main.health()
        self.assertEqual((body.status, body.model_loaded, body.categories), ("degraded", False, []))

    def test_lists_categories_but_not_unknown(self):
        main.state["model"] = FakeModel()
        body = main.health()
        self.assertTrue(body.model_loaded)
        self.assertEqual(body.categories, ["disk-full", "oom-killed"])
        self.assertNotIn(UNKNOWN_LABEL, body.categories)


class PredictTest(WithModel):
    def test_503_without_a_model(self):
        main.state["model"] = None
        with self.assertRaises(HTTPException) as ctx:
            main.predict(PredictRequest(logs="anything"))
        self.assertEqual(ctx.exception.status_code, 503)

    def test_returns_ranked_predictions_and_model_version(self):
        main.state["model"] = FakeModel()
        body = main.predict(PredictRequest(logs="INFO ok\nState: OOMKilled\nINFO ok"))
        self.assertEqual(body.predictions[0].label, "oom-killed")
        self.assertEqual(body.model_version, main.MODEL_VERSION)

    def test_healthy_logs_give_an_empty_list(self):
        # The backend (classifier.service.js) treats [] as "no prediction".
        main.state["model"] = FakeModel()
        self.assertEqual(main.predict(PredictRequest(logs="INFO all good")).predictions, [])


if __name__ == "__main__":
    unittest.main()
