"""Optional integration fixture for an already installed official OpenAI client."""
import json
import sys
from urllib.parse import urlsplit

import httpx
import openai


def main():
    config = json.load(sys.stdin)
    bound = urlsplit(config["base"])
    assert bound.scheme == "http" and bound.hostname == "127.0.0.1"
    assert bound.port not in (None, 8875, 8897) and not bound.path

    def guard(request):
        assert request.url.scheme == "http" and request.url.host == "127.0.0.1"
        assert request.url.port == bound.port and request.url.path.startswith("/v1/")

    client = httpx.Client(trust_env=False, follow_redirects=False, timeout=8, event_hooks={"request": [guard]})
    base = config["base"] + "/v1/"
    model = "fixture:demo"
    messages = [{"role": "user", "content": "alpha bravo charlie"}]
    with openai.OpenAI(base_url=base, api_key=config["runner"], max_retries=0, http_client=client) as api:
        assert model in [row.id for row in api.models.list().data]
        reply = api.chat.completions.create(model=model, messages=messages, max_completion_tokens=24)
        assert reply.choices[0].message.content and reply.usage.completion_tokens > 0
        with api.chat.completions.create(
            model=model, messages=messages, max_tokens=24, stream=True, stream_options={"include_usage": True}
        ) as stream:
            frames = list(stream)
        assert any(record.model_extra.get("acm_provisional") is True for record in frames)
        assert any(choice.finish_reason for record in frames for choice in record.choices)
        assert frames[-1].usage.completion_tokens > 0
        with api.completions.create(model=model, prompt="alpha bravo charlie", max_tokens=24, stream=True) as stream:
            frames = list(stream)
        assert any(record.model_extra.get("acm_provisional") is True for record in frames)
        assert "".join(choice.text for frame in frames for choice in frame.choices)
        assert any(choice.finish_reason for record in frames for choice in record.choices)

    with httpx.Client(trust_env=False, follow_redirects=False, timeout=8, event_hooks={"request": [guard]}) as http:
        with openai.OpenAI(base_url=base, api_key=config["reader"], max_retries=0, http_client=http) as limited:
            try:
                limited.models.list()
            except openai.PermissionDeniedError as error:
                assert error.status_code == 403
            else:
                raise AssertionError("a read-only credential enumerated execution models")

    print(json.dumps({"sdk": openai.__version__, "localhost_only": True,
                      "cases": ["models", "json", "chat-sse", "completion-sse", "scope"]}))


if __name__ == "__main__":
    main()
