"""Render the two trees' demo output as one before/after page. Usage: render.py <before.json> <after.json>"""
import json
import sys

before, after = (json.load(open(path)) for path in sys.argv[1:3])
print("### What the API receives\n\n| Case | Before | After | OpenAPI |\n|---|---|---|---|")
for old, new in zip(before["queries"], after["queries"]):
    print(f"| {old['label']} | `{old['sent']}` | `{new['sent']}` | `{old['expected']}` |")
print("\n### What an import reports\n\n| Operation | Before | After |\n|---|---|---|")
for old, new in zip(before["imports"], after["imports"]):
    print(f"| {old['label']} | {old['outcome']} | {new['outcome']} |")
