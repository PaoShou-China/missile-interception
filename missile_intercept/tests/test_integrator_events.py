"""Generic event and sampled-data semantics for the native integrator."""

import numpy as np
import pytest

import integrator as INT


def _time_event(when, terminal=False):
    def event(t, y):
        return t - when
    event.direction = 1
    event.terminal = terminal
    return event


def test_nonterminal_event_preserves_outer_sample_grid_and_zoh():
    """An event inside a step must not re-sample or shift the outer grid."""
    held_rate = [0.0]
    sample_times = []

    def before_step(t, y):
        sample_times.append(t)
        held_rate[0] = 1.0 + t

    def rhs(t, y):
        return np.array([held_rate[0]])

    sol = INT.integrate(
        rhs, (0.0, 2.0), [0.0], step=1.0,
        events=[_time_event(0.25)], before_step=before_step)

    assert sol.success
    assert sample_times == pytest.approx([0.0, 1.0], abs=1e-12)
    assert sol.t[0] == pytest.approx(2.0)
    assert sol.y[0, -1] == pytest.approx(3.0, abs=1e-10)
    assert sol.t_events[0] == pytest.approx([0.25], abs=1e-9)


def test_terminal_event_after_step_receives_accepted_average_rate():
    """The callback rate must reproduce the state change of a truncated step."""
    callbacks = []

    def rhs(t, y):
        return y

    def after_step(t, y, dy):
        callbacks.append((t, y.copy(), dy.copy()))

    sol = INT.integrate(
        rhs, (0.0, 1.0), [1.0], step=1.0,
        events=[_time_event(0.3, terminal=True)], after_step=after_step)

    assert sol.success and sol.message == "terminal event"
    assert len(callbacks) == 1
    t, y, average = callbacks[0]
    assert t == pytest.approx(sol.t[0], abs=1e-12)
    assert average[0] == pytest.approx((y[0] - 1.0) / t, abs=1e-12)
    assert average[0] != pytest.approx(y[0], abs=1e-4)  # endpoint derivative


def test_nonterminal_event_respects_max_steps():
    """Repeated event-split intervals still count toward the integration cap."""
    events = [_time_event(when) for when in (0.2, 0.4, 0.6)]
    sol = INT.integrate(lambda t, y: np.ones(1), (0.0, 1.0), [0.0],
                        step=1.0, events=events, max_steps=2)
    assert not sol.success
    assert sol.message == "max_steps reached"
    assert sol.nsteps == 2
