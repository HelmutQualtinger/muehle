# Nine Men's Morris (Muehle) game engine — pure logic, no Flask.

# 24 points laid out as 3 concentric squares (corners + side-midpoints),
# connected by four "spokes" through the midpoints.
POINTS = [
    (0, 0), (3, 0), (6, 0), (6, 3), (6, 6), (3, 6), (0, 6), (0, 3),      # 0-7 outer
    (1, 1), (3, 1), (5, 1), (5, 3), (5, 5), (3, 5), (1, 5), (1, 3),      # 8-15 middle
    (2, 2), (3, 2), (4, 2), (4, 3), (4, 4), (3, 4), (2, 4), (2, 3),      # 16-23 inner
]

_SQUARE_EDGES = lambda base: [(base + i, base + (i + 1) % 8) for i in range(8)]
_SPOKE_EDGES = [(1, 9), (9, 17), (3, 11), (11, 19), (5, 13), (13, 21), (7, 15), (15, 23)]

EDGES = _SQUARE_EDGES(0) + _SQUARE_EDGES(8) + _SQUARE_EDGES(16) + _SPOKE_EDGES

ADJACENCY = {i: set() for i in range(24)}
for a, b in EDGES:
    ADJACENCY[a].add(b)
    ADJACENCY[b].add(a)

def _ring_mills(base):
    return [(base + 0, base + 1, base + 2), (base + 2, base + 3, base + 4),
            (base + 4, base + 5, base + 6), (base + 6, base + 7, base + 0)]

MILLS = _ring_mills(0) + _ring_mills(8) + _ring_mills(16) + [
    (1, 9, 17), (3, 11, 19), (5, 13, 21), (7, 15, 23),
]

MILLS_BY_POINT = {i: [m for m in MILLS if i in m] for i in range(24)}

OTHER = {"white": "black", "black": "white"}

STONES_PER_PLAYER = 9


def new_game():
    return {
        "board": [None] * 24,
        "phase": "placing",  # placing -> moving -> gameover (removal handled via pending_removal)
        "turn": "white",
        "stones_to_place": {"white": STONES_PER_PLAYER, "black": STONES_PER_PLAYER},
        "stones_on_board": {"white": 0, "black": 0},
        "pending_removal": False,
        "selected": None,
        "winner": None,
        "message": "Weiss ist am Zug: Stein setzen.",
    }


def _forms_mill(board, point, player):
    return any(all(board[p] == player for p in mill) for mill in MILLS_BY_POINT[point])


def removable_targets(board, opponent):
    opp_points = [i for i in range(24) if board[i] == opponent]
    in_mill = [p for p in opp_points if _forms_mill(board, p, opponent)]
    non_mill = [p for p in opp_points if p not in in_mill]
    return non_mill if non_mill else opp_points


def clone_state(state):
    return {
        "board": state["board"][:],
        "phase": state["phase"],
        "turn": state["turn"],
        "stones_to_place": dict(state["stones_to_place"]),
        "stones_on_board": dict(state["stones_on_board"]),
        "pending_removal": state["pending_removal"],
        "selected": None,
        "winner": state["winner"],
        "message": state["message"],
    }


def _has_legal_move(state, player):
    board = state["board"]
    flying = state["stones_on_board"][player] == 3
    own_points = [i for i in range(24) if board[i] == player]
    if flying:
        return any(board[t] is None for t in range(24)) and len(own_points) > 0
    for p in own_points:
        if any(board[t] is None for t in ADJACENCY[p]):
            return True
    return False


def _advance_turn(state):
    """Called after a placement/move that did NOT form a mill."""
    nxt = OTHER[state["turn"]]
    if state["stones_to_place"]["white"] == 0 and state["stones_to_place"]["black"] == 0:
        state["phase"] = "moving"
    state["turn"] = nxt
    _check_game_over(state)
    if not state["winner"]:
        _set_message(state)


def _check_game_over(state):
    if state["phase"] != "moving":
        return
    player = state["turn"]
    if state["stones_on_board"][player] < 3:
        state["winner"] = OTHER[player]
        state["phase"] = "gameover"
        return
    if not _has_legal_move(state, player):
        state["winner"] = OTHER[player]
        state["phase"] = "gameover"


def _set_message(state):
    names = {"white": "Weiss", "black": "Schwarz"}
    if state["winner"]:
        state["message"] = f"{names[state['winner']]} hat gewonnen!"
        return
    if state["pending_removal"]:
        state["message"] = f"{names[state['turn']]} hat eine Mühle gebildet: gegnerischen Stein entfernen."
        return
    if state["phase"] == "placing":
        state["message"] = f"{names[state['turn']]} ist am Zug: Stein setzen."
    else:
        flying = state["stones_on_board"][state["turn"]] == 3
        verb = "Stein springen lassen" if flying else "Stein ziehen"
        state["message"] = f"{names[state['turn']]} ist am Zug: {verb}."


def place(state, point):
    if state["phase"] != "placing" or state["pending_removal"] or state["winner"]:
        return False, "Setzen ist momentan nicht möglich."
    if not (0 <= point < 24) or state["board"][point] is not None:
        return False, "Ungültiges Feld."
    player = state["turn"]
    if state["stones_to_place"][player] <= 0:
        return False, "Keine Steine mehr zum Setzen."

    state["board"][point] = player
    state["stones_to_place"][player] -= 1
    state["stones_on_board"][player] += 1

    if _forms_mill(state["board"], point, player):
        state["pending_removal"] = True
        _set_message(state)
    else:
        _advance_turn(state)
    return True, None


def move(state, frm, to):
    if state["phase"] != "moving" or state["pending_removal"] or state["winner"]:
        return False, "Ziehen ist momentan nicht möglich."
    player = state["turn"]
    board = state["board"]
    if not (0 <= frm < 24 and 0 <= to < 24):
        return False, "Ungültiges Feld."
    if board[frm] != player:
        return False, "Dort steht kein eigener Stein."
    if board[to] is not None:
        return False, "Zielfeld ist belegt."

    flying = state["stones_on_board"][player] == 3
    if not flying and to not in ADJACENCY[frm]:
        return False, "Zug nur auf ein benachbartes freies Feld erlaubt."

    board[frm] = None
    board[to] = player

    if _forms_mill(board, to, player):
        state["pending_removal"] = True
        _set_message(state)
    else:
        _advance_turn(state)
    return True, None


def remove_stone(state, point):
    if not state["pending_removal"] or state["winner"]:
        return False, "Kein Stein zu entfernen."
    player = state["turn"]
    opponent = OTHER[player]
    board = state["board"]
    if not (0 <= point < 24) or board[point] != opponent:
        return False, "Dort steht kein gegnerischer Stein."
    allowed = removable_targets(board, opponent)
    if point not in allowed:
        return False, "Dieser Stein ist durch eine Mühle geschützt."

    board[point] = None
    state["stones_on_board"][opponent] -= 1
    state["pending_removal"] = False

    if state["stones_to_place"][opponent] == 0 and state["stones_on_board"][opponent] < 3:
        state["winner"] = player
        state["phase"] = "gameover"
        _set_message(state)
        return True, None

    _advance_turn(state)
    return True, None
