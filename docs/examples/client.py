from getpass import getpass
from http.client import HTTPConnection
import re
import sys

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
if not 1 <= port <= 65535 or port in (8875, 8897):
    sys.exit("Use the isolated ACM port")
token = getpass("ACM manage:read token: ")
if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
    sys.exit("Invalid token syntax")
connection = HTTPConnection("127.0.0.1", port, timeout=12)
try:
    connection.request("GET", "/acm/v1/nodes", headers={"Authorization": "Bearer " + token})
    response = connection.getresponse()
    payload = response.read(262145)
    if len(payload) > 262144:
        sys.exit("Response exceeded the documented limit")
    print(payload.decode("utf-8"))
    if response.status != 200:
        sys.exit(1)
finally:
    connection.close()
