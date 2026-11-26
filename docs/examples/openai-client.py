import argparse
from getpass import getpass
import re

import httpx
from openai import OpenAI

parser = argparse.ArgumentParser(description="ACM local simulation with the OpenAI Python SDK")
parser.add_argument("--port", type=int, default=8787)
args = parser.parse_args()
if not 1 <= args.port <= 65535 or args.port in (8875, 8897, 11434):
    parser.error("use the isolated ACM port")
key = getpass("ACM models:run token: ")
if not re.fullmatch(r"[A-Za-z0-9_-]{43}", key):
    parser.error("invalid ACM token format")
with httpx.Client(trust_env=False, follow_redirects=False, timeout=95) as transport:
    with OpenAI(api_key=key, base_url=f"http://127.0.0.1:{args.port}/v1",
                http_client=transport, max_retries=0) as client:
        model = "fixture:demo"
        if model not in {entry.id for entry in client.models.list().data}:
            parser.error("use an authorized local simulation installation")
        chunks = []
        complete = False
        for event in client.chat.completions.create(
            model=model, messages=[{"role": "user", "content": "ACM synthetic example"}],
            max_tokens=12, stream=True, stream_options={"include_usage": True}
        ):
            for choice in event.choices:
                if choice.delta.content:
                    chunks.append(choice.delta.content)
                if choice.finish_reason:
                    complete = True
        if not complete:
            parser.error("terminal result could not be confirmed")
        print("".join(chunks))
