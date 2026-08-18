# Minimax (alpha-beta) computer opponent for Muehle.
# Operates one atomic action (place/move/remove) at a time — game.py already
# encodes whose turn it is next, so the search tree needs no extra bookkeeping
# for the placement/moving/removal phases.

import random
import time

import game

WIN_SCORE = 100_000

# Iterative deepening within a wall-clock budget, rather than a fixed depth:
# it searches as deep as the position allows in the time available, so it
# plays much stronger in the (small-branching) endgame without risking a
# multi-second hang during the (large-branching) placing phase.
TIME_BUDGET_SECONDS = 1.2
MAX_DEPTH = 12

# Degree-based point value: the four middle-ring "cross" points (degree 4)
# are the strongest squares on the board (most future mobility / mill
# options), plain T-junctions (degree 3) are next, corners (degree 2) least.
POINT_WEIGHT = {p: len(game.ADJACENCY[p]) - 1 for p in range(24)}


class _SearchTimeout(Exception):
    pass


def legal_actions(state):
    if state["winner"]:
        return []

    if state["pending_removal"]:
        opponent = game.OTHER[state["turn"]]
        return [("remove", p) for p in game.removable_targets(state["board"], opponent)]

    if state["phase"] == "placing":
        return [("place", p) for p in range(24) if state["board"][p] is None]

    player = state["turn"]
    board = state["board"]
    flying = state["stones_on_board"][player] == 3
    actions = []
    for p in range(24):
        if board[p] != player:
            continue
        targets = range(24) if flying else game.ADJACENCY[p]
        for t in targets:
            if board[t] is None:
                actions.append(("move", p, t))
    return actions


def apply_action(state, action):
    s = game.clone_state(state)
    kind = action[0]
    if kind == "place":
        game.place(s, action[1])
    elif kind == "move":
        game.move(s, action[1], action[2])
    else:
        game.remove_stone(s, action[1])
    return s


def _action_priority(state, action):
    """Cheap move-ordering heuristic: try mill-forming and high-value-point
    actions first, so alpha-beta prunes more of the tree at a given depth."""
    kind = action[0]
    if kind == "remove":
        return POINT_WEIGHT[action[1]]

    board = state["board"]
    player = state["turn"]
    if kind == "place":
        point = action[1]
        board[point] = player
        forms = game.forms_mill(board, point, player)
        board[point] = None
    else:
        frm, to = action[1], action[2]
        board[frm] = None
        board[to] = player
        forms = game.forms_mill(board, to, player)
        board[to] = None
        board[frm] = player
        point = to

    return (1000 if forms else 0) + POINT_WEIGHT[point]


def _count_moves(state, player):
    board = state["board"]
    flying = state["stones_on_board"][player] == 3
    total = 0
    for p in range(24):
        if board[p] != player:
            continue
        targets = range(24) if flying else game.ADJACENCY[p]
        total += sum(1 for t in targets if board[t] is None)
    return total


def _open_mill_threats(state, player):
    board = state["board"]
    count = 0
    for mill in game.MILLS:
        owners = [board[p] for p in mill]
        if owners.count(player) == 2 and owners.count(None) == 1:
            count += 1
    return count


def evaluate(state, computer_color):
    human_color = game.OTHER[computer_color]

    if state["winner"] == computer_color:
        return WIN_SCORE
    if state["winner"] == human_color:
        return -WIN_SCORE

    board = state["board"]
    comp_material = state["stones_on_board"][computer_color] + state["stones_to_place"][computer_color]
    human_material = state["stones_on_board"][human_color] + state["stones_to_place"][human_color]
    score = (comp_material - human_material) * 100

    if state["phase"] == "moving":
        comp_mobility = _count_moves(state, computer_color)
        human_mobility = _count_moves(state, human_color)
        score += (comp_mobility - human_mobility) * 2
        # Near-zero mobility is close to an outright loss (stalemate rule).
        if comp_mobility == 0:
            score -= 60
        if human_mobility == 0:
            score += 60

    comp_threats = _open_mill_threats(state, computer_color)
    human_threats = _open_mill_threats(state, human_color)
    score += (comp_threats - human_threats) * 15
    # A double threat can't be fully blocked in one reply — worth extra.
    if comp_threats >= 2:
        score += 35
    if human_threats >= 2:
        score -= 35

    comp_position = sum(POINT_WEIGHT[p] for p in range(24) if board[p] == computer_color)
    human_position = sum(POINT_WEIGHT[p] for p in range(24) if board[p] == human_color)
    score += (comp_position - human_position) * 6

    return score


def _minimax(state, depth, alpha, beta, computer_color, deadline):
    if time.monotonic() > deadline:
        raise _SearchTimeout()

    if state["winner"] or depth == 0:
        return evaluate(state, computer_color), None

    actions = legal_actions(state)
    if not actions:
        return evaluate(state, computer_color), None

    actions.sort(key=lambda a: _action_priority(state, a), reverse=True)

    maximizing = state["turn"] == computer_color
    best_actions = []
    best_value = -float("inf") if maximizing else float("inf")

    for action in actions:
        child = apply_action(state, action)
        value, _ = _minimax(child, depth - 1, alpha, beta, computer_color, deadline)

        if maximizing:
            if value > best_value:
                best_value, best_actions = value, [action]
            elif value == best_value:
                best_actions.append(action)
            alpha = max(alpha, value)
        else:
            if value < best_value:
                best_value, best_actions = value, [action]
            elif value == best_value:
                best_actions.append(action)
            beta = min(beta, value)

        if alpha >= beta:
            break

    return best_value, random.choice(best_actions)


def choose_action(state, computer_color):
    actions = legal_actions(state)
    if not actions:
        return None
    if len(actions) == 1:
        return actions[0]

    actions.sort(key=lambda a: _action_priority(state, a), reverse=True)
    best_action = actions[0]

    deadline = time.monotonic() + TIME_BUDGET_SECONDS
    depth = 1
    while depth <= MAX_DEPTH and time.monotonic() < deadline:
        try:
            _, action = _minimax(state, depth, -float("inf"), float("inf"), computer_color, deadline)
        except _SearchTimeout:
            break
        if action is not None:
            best_action = action
        depth += 1

    return best_action
