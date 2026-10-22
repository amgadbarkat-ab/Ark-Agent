"""The line each run writes says what reached the model, and carries no key."""

from src.run_summary import describe_run, host_of, opening_of


def test_says_what_reached_the_model():
    line = describe_run(
        model="command-a",
        host="openrouter.ai",
        chosen=True,
        system_characters=9000,
        role="You are Ada,\n  Chief of Operations. You lead this team.",
        offered=["team_ask", "team_list"],
        left_out=[],
    )
    assert line == (
        "run: model=command-a host=openrouter.ai chosen=true system=9000 chars role=55 chars "
        'role_opening="You are Ada, Chief of Operations. You lead this team." '
        "tools=2 [team_ask,team_list] left_out=[none]"
    )


def test_reads_a_host_and_nothing_else():
    assert host_of("https://openrouter.ai/api/v1") == "openrouter.ai"
    assert host_of("http://127.0.0.1:8080/v1") == "127.0.0.1:8080"
    assert host_of(None) == ""


def test_the_opening_of_a_role_is_short_and_on_one_line():
    assert opening_of("You are\n  Ada. " + "x" * 100, 20) == "You are Ada. xxxxxxx"
