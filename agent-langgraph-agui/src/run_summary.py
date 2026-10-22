"""One line per run saying what actually reached the model.

"The employee does not know its role" has three possible causes that look identical from the chat:
the role was never sent, it was sent and lost on the way, or the model was handed it and ignored it.
Two of those are visible here, which settles which it was without asking anyone to open a developer
console. Nothing in it is a secret: the model's name, the host it was reached at, sizes, and names
of tools. Same line as `shared/run-summary.ts`, which the other two Bots write.
"""

from urllib.parse import urlparse


def host_of(address) -> str:
    if not isinstance(address, str) or not address:
        return ""
    try:
        return urlparse(address).netloc
    except ValueError:
        return ""


def opening_of(role: str, length: int = 60) -> str:
    return " ".join(role.split())[:length]


def describe_run(
    *,
    model: str,
    host: str,
    chosen: bool,
    system_characters: int,
    role: str,
    offered: list[str],
    left_out: list[str],
) -> str:
    def names(values: list[str]) -> str:
        return ",".join(values) if values else "none"

    return (
        f"run: model={model} host={host} chosen={str(chosen).lower()} "
        f"system={system_characters} chars role={len(role)} chars "
        f'role_opening="{opening_of(role)}" '
        f"tools={len(offered)} [{names(offered)}] left_out=[{names(left_out)}]"
    )
