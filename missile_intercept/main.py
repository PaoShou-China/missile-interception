"""System integration: sampled-data loop, native RK4, telemetry and plotting.

Run:
    python main.py                     # 5 ms outer step (config.DEFAULT_MAX_STEP)
    python main.py --max-step 0.002    # finer step
    python main.py --no-plot           # simulation + CSV only
    python main.py --converge          # step-size convergence of the miss distance
    python main.py --batch 20 --workers 8   # Monte-Carlo batch (see batch.py)

Architecture
------------
Sensors, guidance and actuators are sampled once per outer step and held
constant (ZOH) while the continuous dynamics are integrated with the native
RK4 stepper in ``integrator.py``.  No sampled-data module runs inside the
RHS, so the integration is deterministic and free of rejected-step side
effects.
"""

import argparse
import dataclasses
import math
import os
import time
import numpy as np

import config as C
import math_utils as MU
import integrator as INT
import fastcore as FC
from telemetry import TelemetryLogger
from vehicle.missile import (
    Missile, aerothermal_state, step_transient_wall_temp, static_margin,
)
from vehicle.warhead import proximity_fuze_lethality
from vehicle.target import Target
from vehicle.atmosphere import get_atmosphere
from sensors.navigation import NavigationSystem
from sensors.seeker import Seeker
from sensors.target_tracker import TargetTracker
from sensors.imu import IMU, StarTracker, AttitudeEstimator
from vehicle.wind import WindModel
from state_schema import (SYSTEM_SCHEMA, SL_M_POS, SL_M_VEL, SL_M_ATT,
                          SL_M_OMEGA, SL_M_MASS, SL_T_POS, SL_T_VEL)
from control.autopilot import Autopilot, BendingModePlant, BiquadNotchFilter
from control.classic_autopilot import ClassicAutopilot
from control.fin_mixer import FinMixer
from control.thrust_controller import ThrustController
from guidance.boost_guidance import BoostGuidance
from guidance.fixed_rate_boost_guidance import FixedRateBoostGuidance
from guidance.midcourse_guidance import MidcourseGuidance
from guidance.pip_midcourse_guidance import PipMidcourseGuidance
from guidance.terminal_guidance import TerminalGuidance
from guidance.pure_pn_guidance import PurePNGuidance
from guidance.handover_manager import HandoverManager

BOOST_END_TIME = C.BOOST_END_TIME
PHASE_CODE = {"boost": 0.0, "midcourse": 1.0, "terminal": 2.0}

# Guidance-law factories: the law name lives in SimConfig so a batch case is
# fully described by (SimConfig, Scenario) and stays reproducible.
_MIDCOURSE_LAWS = {
    "bezier": MidcourseGuidance,
    "pip_pn": PipMidcourseGuidance,
}
_TERMINAL_LAWS = {
    "zem_apn": TerminalGuidance,
    "pn": PurePNGuidance,
}
_BOOST_LAWS = {
    "feasible": BoostGuidance,
    "fixed_rate": FixedRateBoostGuidance,
}
_CONTROL_LAWS = {
    "scheduled": Autopilot,
    "classic_pid": ClassicAutopilot,
}


def make_boost_guidance(law):
    try:
        return _BOOST_LAWS[law]()
    except KeyError:
        raise ValueError("Unknown boost law %r (choose from %s)"
                         % (law, ", ".join(sorted(_BOOST_LAWS))))


def make_autopilot(law, dt):
    try:
        return _CONTROL_LAWS[law](dt)
    except KeyError:
        raise ValueError("Unknown control law %r (choose from %s)"
                         % (law, ", ".join(sorted(_CONTROL_LAWS))))


def make_midcourse_guidance(law):
    try:
        return _MIDCOURSE_LAWS[law]()
    except KeyError:
        raise ValueError("Unknown midcourse law %r (choose from %s)"
                         % (law, ", ".join(sorted(_MIDCOURSE_LAWS))))


def make_terminal_guidance(law):
    try:
        return _TERMINAL_LAWS[law]()
    except KeyError:
        raise ValueError("Unknown terminal law %r (choose from %s)"
                         % (law, ", ".join(sorted(_TERMINAL_LAWS))))

# Aggregate slices derived from the schema (never hard-coded offsets).
SL_M_STATE = slice(SL_M_POS.start, SL_M_MASS.stop)
SL_T_STATE = slice(SL_T_POS.start, SL_T_VEL.stop)


# ============================================================
# Multi-rate scheduler (zero-order hold)
# ============================================================
class MultiRateScheduler(object):
    """Trigger modules on fixed periods; untriggered modules hold their output."""

    def __init__(self, cfg):
        self.periods = {
            "seeker": cfg.dt_seeker,
            "autopilot": cfg.dt_autopilot,
            "guidance": cfg.dt_guidance,
            "log": cfg.dt_log,
            "datalink": cfg.datalink_period,
            "star": C.STAR_PERIOD,
        }
        self.next_t = {k: 0.0 for k in self.periods}

    def reset(self):
        for k in self.next_t:
            self.next_t[k] = 0.0

    def due(self, name, t):
        """Floating-point-safe trigger test; catches up if a step skips periods."""
        period = self.periods[name]
        if t + 1e-9 >= self.next_t[name]:
            nxt = self.next_t[name] + period
            missed = 0
            while nxt <= t + 1e-9 and missed < 10000:
                nxt += period
                missed += 1
            self.next_t[name] = nxt
            return True
        return False


# ============================================================
# Simulation
# ============================================================
class Simulation(object):
    def __init__(self, cfg=None, scenario=None):
        self.cfg = cfg if cfg is not None else C.SimConfig()
        self.scenario = scenario if scenario is not None else C.Scenario()

        self.missile = Missile()
        self.target = Target(
            lat=self.scenario.target_lat, lon=self.scenario.target_lon,
            alt=self.scenario.target_alt, mach=self.scenario.target_mach,
            launch_lat=self.scenario.launch_lat, launch_lon=self.scenario.launch_lon,
            launch_alt=self.scenario.launch_alt,
            evade_g=self.scenario.target_evade_g,
            evade_phase=self.scenario.target_evade_phase,
            maneuver_dist=self.scenario.target_maneuver_dist)
        self.nav = NavigationSystem(self.cfg.dt_gnss, self.cfg.nav_delay,
                                    seed=self.scenario.nav_seed,
                                    noise_scale=self.cfg.sensor_noise_scale)
        self.seeker = Seeker(seed=self.scenario.seeker_seed,
                             noise_scale=self.cfg.sensor_noise_scale,
                             swerling=self.cfg.seeker_swerling,
                             dropout_rate=self.cfg.seeker_dropout_rate,
                             false_lock_rate=self.cfg.seeker_false_lock_rate)
        self.imu = IMU(seed=C.IMU_SEED + int(self.scenario.nav_seed),
                       noise_scale=self.cfg.sensor_noise_scale)
        self.star = StarTracker(seed=C.STAR_SEED + int(self.scenario.nav_seed),
                                noise_scale=self.cfg.sensor_noise_scale)
        self.wind = WindModel(seed=C.WIND_SEED + int(self.scenario.nav_seed),
                              enabled=self.cfg.enable_wind,
                              noise_scale=self.cfg.sensor_noise_scale)
        # Guidance consumes only this estimate (pre-launch cue + seeker fixes),
        # never the integrated target truth state.
        cue = self.target.initial_state().copy()
        if (self.scenario.cue_pos_sigma > 0.0
                or self.scenario.cue_vel_sigma > 0.0):
            rng = np.random.RandomState(int(self.scenario.cue_seed)
                                        + int(self.scenario.nav_seed))
            cue[0:3] += rng.normal(0.0, self.scenario.cue_pos_sigma, 3)
            cue[3:6] += rng.normal(0.0, self.scenario.cue_vel_sigma, 3)
        self.tracker = TargetTracker(
            cue,
            pos_sigma=max(C.TGT_TRACK_CUE_POS_SIGMA,
                          self.scenario.cue_pos_sigma),
            vel_sigma=max(C.TGT_TRACK_CUE_VEL_SIGMA,
                          self.scenario.cue_vel_sigma),
            noise_scale=self.cfg.sensor_noise_scale)
        # Offboard datalink noise stream (independent from nav/seeker/cue).
        self._datalink_rng = np.random.RandomState(
            C.DATALINK_SEED + int(self.scenario.nav_seed))
        self.autopilot = make_autopilot(self.cfg.control_law,
                                        self.cfg.dt_autopilot)
        self.fin_mixer = FinMixer(self.cfg.dt_autopilot)
        self.thrust_ctrl = ThrustController()
        self.throttle_cmd = 1.0
        self.boost = make_boost_guidance(self.cfg.boost_law)
        self.midcourse = make_midcourse_guidance(self.cfg.midcourse_law)
        self.terminal = make_terminal_guidance(self.cfg.terminal_law)
        self.handover = HandoverManager()
        self.scheduler = MultiRateScheduler(self.cfg)
        profile = str(self.cfg.telemetry_profile)
        if profile == "none":
            self.telemetry = TelemetryLogger(0, C.TELEMETRY_BASIC_COLUMNS, enabled=False)
        else:
            columns = (C.TELEMETRY_COLUMNS if profile == "full"
                       else C.TELEMETRY_BASIC_COLUMNS)
            self.telemetry = TelemetryLogger(self.cfg.max_steps, columns, enabled=True)

        # Pre-allocated scratch buffers for zero-allocation fused RK4 & logging.
        self._rk4_y_next_a = np.empty(20, dtype=np.float64)
        self._rk4_y_next_b = np.empty(20, dtype=np.float64)
        self._rk4_f_avg = np.empty(20, dtype=np.float64)
        self._rk4_k1 = np.empty(20, dtype=np.float64)
        self._rk4_k2 = np.empty(20, dtype=np.float64)
        self._rk4_k3 = np.empty(20, dtype=np.float64)
        self._rk4_k4 = np.empty(20, dtype=np.float64)
        self._rk4_ytmp = np.empty(20, dtype=np.float64)
        self._rk4_Fb = np.empty(3, dtype=np.float64)
        self._rk4_Mb = np.empty(3, dtype=np.float64)
        self._rk4_dcm = np.empty((3, 3), dtype=np.float64)
        self._rk4_buf_flip = False
        self._has_rk4_favg = False
        self._log_buf = (np.empty(self.telemetry.n_cols - 1, dtype=np.float64)
                         if self.telemetry.enabled else None)
        self._t_ap = -1.0
        self._last_range_m = 2.0e6
        self._min_range_m = float("inf")
        self._min_range_t = float("nan")
        # O(1) running stage/terminal statistics (used even when telemetry_profile="none").
        self._acc = {
            "boost_peak_alpha": 0.0,
            "boost_sat_cnt": 0,
            "boost_cnt": 0,
            "mid_started": False,
            "boost_end_time": float("nan"),
            "boost_end_alt_km": float("nan"),
            "boost_end_mach": float("nan"),
            "boost_end_speed": float("nan"),
            "boost_end_gamma_deg": float("nan"),
            "mid_peak_mach": 0.0,
            "mid_peak_alt_km": 0.0,
            "mid_min_speed": float("inf"),
            "mid_peak_q_kpa": 0.0,
            "mid_peak_alpha": 0.0,
            "mid_sat_cnt": 0,
            "mid_cnt": 0,
            "term_started": False,
            "term_start_time": float("nan"),
            "handover_specific_energy_mjkg": float("nan"),
            "ho_first_t": float("nan"),
            "ho_last_t": float("nan"),
            "ho_peak_cmd_g": 0.0,
            "ho_peak_act_g": 0.0,
            "ho_fov_max": 0.0,
            "ho_lock_cnt": 0,
            "ho_min_range": float("inf"),
            "ho_peak_alpha": 0.0,
            "ho_peak_beta": 0.0,
            "ho_sat_cnt": 0,
            "ho_cnt": 0,
        }

        # Initial state (vertical cold launch)
        r0 = MU.llh_to_eci(self.scenario.launch_lat, self.scenario.launch_lon,
                           self.scenario.launch_alt, 0.0)
        up = MU.local_up(r0)
        r_t0 = MU.llh_to_eci(self.scenario.target_lat, self.scenario.target_lon,
                             self.scenario.target_alt, 0.0)
        h_dir = MU.normalize(MU.perpendicular(r_t0 - r0, up))
        # uniflight-style launch alignment: +x_B along up, +z_B along up x h_dir
        # (equivalently +y_B towards the target bearing).  Vertical cold launch
        # is a regular case for this construction.
        q0 = MU.quat_align_body_x(up, np.cross(up, h_dir))
        v0 = np.cross(np.array([0.0, 0.0, C.OMEGA_EARTH]), r0)

        t_target0 = self.target.initial_state()
        self.y0 = SYSTEM_SCHEMA.pack({
            "m_position": r0,
            "m_velocity": v0,
            "m_attitude": q0,
            "m_angular_rate": np.zeros(3),
            "m_mass": self.missile.mass0,
            "t_position": t_target0[0:3],
            "t_velocity": t_target0[3:6],
        })
        # Sign reference for the integrated quaternion: q and -q are the same
        # attitude, so the state must stay in one hemisphere for dense output
        # and event interpolation to remain continuous.
        self._q_ref = q0.copy()

        # ZOH caches
        self.nav_est = C.NavEstimate(r_eci=r0.copy(), v_eci=np.zeros(3), timestamp=0.0)
        self.seeker_meas = None
        self._seeker_updated = False
        self.guidance_cmd = C.GuidanceCommand(a_cmd_eci=np.zeros(3), phase="boost")
        self.act_cmd = C.ActuatorCommand(delta_fins=np.zeros(4), is_saturated=False)
        self._fins_zoh = np.zeros(4)   # contiguous ZOH fin copy for the compiled RHS
        # Control-command delay line: (time, fin command) pairs awaiting the
        # transport delay before they reach the actuators.
        self._fin_delay = []
        # Estimated attitude/rate used by the control loop (IMU-propagated,
        # star-aided; the gyro bias is estimated alongside).
        self.att = AttitudeEstimator(q0)
        self.omega_meas = np.zeros(3)
        self._t_imu = 0.0
        self._t_star = 0.0
        self._t_star_fix = 0.0
        self._wind_zoh = np.zeros(3)
        self._t_wind = 0.0
        self._dl_queue = []            # (arrival_time, z_r, z_v, sigma_r, sigma_v)
        self.phase = "boost"
        self.handover_flag = 0.0
        # Handover diagnostics (consumed by tools/handover_diagnostics.py).
        self.first_lock_time = None
        self.first_lock_range = None
        self.first_lock_fov = None
        self.handover_info = {}
        self.handover_trigger = None
        self.miss_distance = np.nan
        self.miss_time = np.nan
        self._miss_armed = False
        self.cpu_time = 0.0
        self.sol = None

        # Phase-1/2 physical state trackers: 1D transient nose-cap TPS temp,
        # discrete Stage-1 separation, inlet unstart latch, optional flex-body
        # bending mode + notch filter, and terminal proximity fuze report.
        atm0 = get_atmosphere(max(float(self.scenario.launch_alt), 0.0))
        self._wall_temp_k = float(atm0.temperature)
        self._wall_temp_eq_k = float(atm0.temperature)
        self._heat_flux_mw = 0.0
        self._t_thermal = 0.0
        self._stage_separated = False
        self._inlet_unstart = False
        self._flex_plant = BendingModePlant()
        self._flex_notch = BiquadNotchFilter(dt=self.cfg.dt_autopilot)
        self._live_fuze_pk = 0.0
        self.fuze_report = None

        # Seed the monitor cache with one evaluation at t=0.
        dy0, info0 = self.missile.derivatives(0.0, self.y0[0:14], self.act_cmd.delta_fins)
        self._last_info = info0
        self._a_true = np.asarray(dy0[3:6], dtype=float).copy()
        self._last_alpha = float(info0["alpha"])
        self._last_cn_alpha = float(info0["CN_ALPHA"])
        self._last_q_dyn = float(info0["q_dyn"])

    # --------------------------------------------------------
    def reset(self):
        """Restore the initial state (repeatable tests)."""
        self.__init__(self.cfg, self.scenario)

    # --------------------------------------------------------
    def _event_miss(self, t, y):
        """Range-rate zero crossing: negative to positive gives closest approach.

        The event is armed only once the range has closed inside the gate.
        Arming happens while R is decreasing, so the -1 -> negative transition
        can never fake a negative-to-positive crossing.  A plain value gate
        would instead jump from -1 to the raw range rate on the gate boundary
        and could fire a spurious ~300 km "miss" during a midcourse loft.
        """
        r = y[SL_M_POS]
        v = y[SL_M_VEL]
        rho = y[SL_T_POS] - r
        R = MU.norm3(rho)
        if R < C.MISS_GATE_RADIUS:
            self._miss_armed = True
        if not self._miss_armed:
            return -1.0
        return float(np.dot(y[SL_T_VEL] - v, rho) / max(R, 1e-6))

    def _event_ground(self, t, y):
        """Ground impact event; disabled during the first second of launch."""
        if t < 1.0:
            return 1.0
        return float(MU.altitude(y[SL_M_POS]))

    # --------------------------------------------------------
    def _rhs(self, t, y):
        """Continuous dynamics only; sampled-data modules are frozen outside."""
        self._has_rk4_favg = False
        if FC.NUMBA_AVAILABLE:
            (dy, alpha, beta, mach, q_dyn, alt, cn_a, Fb, Mb, dcm, mdot,
             thrust, phase_code) = FC.system_derivatives(
                float(t), np.ascontiguousarray(y), self._fins_zoh,
                self.missile.mass0, self.missile.dry_mass, self.missile.fuel0,
                self.missile.S, self.missile.L, float(self.throttle_cmd),
                float(self._wind_zoh[0]), float(self._wind_zoh[1]),
                float(self._wind_zoh[2]),
                float(self.target.evade_g), float(self.target.maneuver_dist),
                float(self.target.evade_phase),
                1 if self._inlet_unstart else 0)
            info = self._last_info
            info["alt"] = float(alt)
            info["mach"] = float(mach)
            info["q_dyn"] = float(q_dyn)
            info["alpha"] = float(alpha)
            info["beta"] = float(beta)
            info["thrust"] = float(thrust)
            info["mdot"] = float(mdot)
            info["CN_ALPHA"] = float(cn_a)
            info["F_body"] = Fb
            info["M_body"] = Mb
            info["dcm_be"] = dcm
            info["phase"] = ("boost" if phase_code == 0
                             else ("ramjet" if phase_code == 1 else "coast"))
            self._last_alpha = float(alpha)
            self._last_cn_alpha = float(cn_a)
            self._last_q_dyn = float(q_dyn)
            return dy

        dy_m, info = self.missile.derivatives(
            t, y[SL_M_STATE], self._fins_zoh,
            throttle=self.throttle_cmd, wind=self._wind_zoh,
            unstart=self._inlet_unstart)
        self._last_info = info
        self._last_alpha = float(info["alpha"])
        self._last_cn_alpha = float(info["CN_ALPHA"])
        self._last_q_dyn = float(info["q_dyn"])

        dy_t = self.target.derivatives(t, y[SL_T_STATE], y[SL_M_POS])
        return np.concatenate((dy_m, dy_t))

    # --------------------------------------------------------
    def _stepper(self, t, y, h):
        """Fused zero-allocation RK4 stepper inside one nogil Numba call.

        Uses ping-pong output buffers (``_rk4_y_next_a`` / ``_b``) so ``y_out``
        never aliases ``y`` in ``integrator.integrate``, eliminating per-step
        array copies and 4x Python<->JIT boundary crossings.
        """
        y_out = self._rk4_y_next_b if self._rk4_buf_flip else self._rk4_y_next_a
        self._rk4_buf_flip = not self._rk4_buf_flip
        n_sub = 2 if h > 0.015 else 1
        (alpha, beta, mach, q_dyn, alt, cn_a, mdot, thrust,
         phase_code) = FC.rk4_multi_step_system_into(
            float(t), y, float(h), n_sub, self._fins_zoh,
            self.missile.mass0, self.missile.dry_mass, self.missile.fuel0,
            self.missile.S, self.missile.L, float(self.throttle_cmd),
            float(self._wind_zoh[0]), float(self._wind_zoh[1]),
            float(self._wind_zoh[2]),
            float(self.target.evade_g), float(self.target.maneuver_dist),
            float(self.target.evade_phase),
            1 if self._inlet_unstart else 0,
            y_out, self._rk4_f_avg,
            self._rk4_k1, self._rk4_k2, self._rk4_k3, self._rk4_k4,
            self._rk4_ytmp, self._rk4_Fb, self._rk4_Mb, self._rk4_dcm)
        info = self._last_info
        info["alt"] = float(alt)
        info["mach"] = float(mach)
        info["q_dyn"] = float(q_dyn)
        info["alpha"] = float(alpha)
        info["beta"] = float(beta)
        info["thrust"] = float(thrust)
        info["mdot"] = float(mdot)
        info["CN_ALPHA"] = float(cn_a)
        info["F_body"] = self._rk4_Fb
        info["M_body"] = self._rk4_Mb
        info["dcm_be"] = self._rk4_dcm
        info["phase"] = ("boost" if phase_code == 0
                         else ("ramjet" if phase_code == 1 else "coast"))
        self._last_alpha = float(alpha)
        self._last_cn_alpha = float(cn_a)
        self._last_q_dyn = float(q_dyn)
        self._has_rk4_favg = True
        return y_out, self._rk4_f_avg, 4 * n_sub

    # --------------------------------------------------------
    def _update_running_stats(self, t, y):
        """O(1) scalar phase/terminal statistics (works when telemetry is disabled)."""
        acc = self._acc
        info = self._last_info
        r = y[SL_M_POS]
        v = y[SL_M_VEL]
        r_t = y[SL_T_POS]
        dx = float(r_t[0] - r[0])
        dy = float(r_t[1] - r[1])
        dz = float(r_t[2] - r[2])
        R = math.sqrt(dx * dx + dy * dy + dz * dz)
        self._last_range_m = R
        if R < self._min_range_m:
            self._min_range_m = R
            self._min_range_t = float(t)

        speed = math.sqrt(float(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]))
        alt = float(info.get("alt", 0.0))
        mach = float(info.get("mach", 0.0))
        q_dyn = float(info.get("q_dyn", 0.0))
        alpha_abs = abs(float(info.get("alpha", 0.0)))
        beta_abs = abs(float(info.get("beta", 0.0)))
        sat = 1 if self.act_cmd.is_saturated else 0
        ph = self.phase

        if ph == "boost":
            acc["boost_cnt"] += 1
            acc["boost_sat_cnt"] += sat
            if alpha_abs > acc["boost_peak_alpha"]:
                acc["boost_peak_alpha"] = alpha_abs
        else:
            if not acc["mid_started"]:
                acc["mid_started"] = True
                acc["boost_end_time"] = float(t)
                acc["boost_end_alt_km"] = alt * 1e-3
                acc["boost_end_mach"] = mach
                acc["boost_end_speed"] = speed
                if acc["boost_cnt"] > 0 and speed > 1e-6:
                    r_norm = math.sqrt(float(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]))
                    if r_norm > 1e-6:
                        dot_vu = float(r[0] * v[0] + r[1] * v[1] + r[2] * v[2]) / (r_norm * speed)
                        dot_vu = -1.0 if dot_vu < -1.0 else (1.0 if dot_vu > 1.0 else dot_vu)
                        acc["boost_end_gamma_deg"] = math.degrees(math.asin(dot_vu))
            if ph == "midcourse":
                acc["mid_cnt"] += 1
                acc["mid_sat_cnt"] += sat
                if mach > acc["mid_peak_mach"]:
                    acc["mid_peak_mach"] = mach
                alt_km = alt * 1e-3
                if alt_km > acc["mid_peak_alt_km"]:
                    acc["mid_peak_alt_km"] = alt_km
                if speed < acc["mid_min_speed"]:
                    acc["mid_min_speed"] = speed
                q_kpa = q_dyn * 1e-3
                if q_kpa > acc["mid_peak_q_kpa"]:
                    acc["mid_peak_q_kpa"] = q_kpa
                if alpha_abs > acc["mid_peak_alpha"]:
                    acc["mid_peak_alpha"] = alpha_abs
            elif ph == "terminal" and not acc["term_started"]:
                acc["term_started"] = True
                acc["term_start_time"] = float(t)
                acc["handover_specific_energy_mjkg"] = (
                    0.5 * speed * speed + C.G0 * alt) * 1e-6

        if self.handover_flag > 0.5:
            if acc["ho_cnt"] == 0:
                acc["ho_first_t"] = float(t)
            acc["ho_last_t"] = float(t)
            acc["ho_cnt"] += 1
            acc["ho_sat_cnt"] += sat
            a_cmd = self.guidance_cmd.a_cmd_eci
            cmd_g = math.sqrt(float(a_cmd[0] * a_cmd[0] + a_cmd[1] * a_cmd[1]
                                    + a_cmd[2] * a_cmd[2])) / C.G0
            if cmd_g > acc["ho_peak_cmd_g"]:
                acc["ho_peak_cmd_g"] = cmd_g
            fb = info.get("F_body")
            mass = max(float(y[SL_M_MASS.start]), 1e-6)
            if fb is not None:
                act_g = math.sqrt(float(fb[0] * fb[0] + fb[1] * fb[1]
                                        + fb[2] * fb[2])) / (mass * C.G0)
                if act_g > acc["ho_peak_act_g"]:
                    acc["ho_peak_act_g"] = act_g
            seeker = self.seeker_meas
            if seeker is not None:
                fov = float(seeker.fov_angle)
                if fov > acc["ho_fov_max"]:
                    acc["ho_fov_max"] = fov
                if seeker.is_locked:
                    acc["ho_lock_cnt"] += 1
            if R < acc["ho_min_range"]:
                acc["ho_min_range"] = R
            if alpha_abs > acc["ho_peak_alpha"]:
                acc["ho_peak_alpha"] = alpha_abs
            if beta_abs > acc["ho_peak_beta"]:
                acc["ho_peak_beta"] = beta_abs

    def stage_summary(self):
        """Return per-phase scalar metrics compatible with ``batch._stage_fields``."""
        acc = self._acc
        nan = float("nan")
        if not acc["mid_started"]:
            return {
                "boost_end_time": nan,
                "boost_end_alt_km": nan,
                "boost_end_mach": nan,
                "boost_end_speed": nan,
                "boost_end_gamma_deg": nan,
                "boost_peak_alpha_deg": nan,
                "boost_fin_sat_pct": nan,
                "midcourse_duration_s": nan,
                "midcourse_peak_mach": nan,
                "midcourse_peak_alt_km": nan,
                "midcourse_min_speed": nan,
                "midcourse_peak_q_kpa": nan,
                "midcourse_peak_alpha_deg": nan,
                "midcourse_fin_sat_pct": nan,
                "handover_specific_energy_mjkg": nan,
            }
        has_boost = acc["boost_cnt"] > 0
        has_mid = acc["mid_cnt"] > 0
        return {
            "boost_end_time": float(acc["boost_end_time"]),
            "boost_end_alt_km": float(acc["boost_end_alt_km"]),
            "boost_end_mach": float(acc["boost_end_mach"]),
            "boost_end_speed": float(acc["boost_end_speed"]),
            "boost_end_gamma_deg": float(acc["boost_end_gamma_deg"]),
            "boost_peak_alpha_deg": (math.degrees(acc["boost_peak_alpha"])
                                     if has_boost else nan),
            "boost_fin_sat_pct": (100.0 * acc["boost_sat_cnt"] / acc["boost_cnt"]
                                  if has_boost else nan),
            "midcourse_duration_s": (float(acc["term_start_time"] - acc["boost_end_time"])
                                     if acc["term_started"] else nan),
            "midcourse_peak_mach": float(acc["mid_peak_mach"]) if has_mid else nan,
            "midcourse_peak_alt_km": float(acc["mid_peak_alt_km"]) if has_mid else nan,
            "midcourse_min_speed": float(acc["mid_min_speed"]) if has_mid else nan,
            "midcourse_peak_q_kpa": float(acc["mid_peak_q_kpa"]) if has_mid else nan,
            "midcourse_peak_alpha_deg": (math.degrees(acc["mid_peak_alpha"])
                                         if has_mid else nan),
            "midcourse_fin_sat_pct": (100.0 * acc["mid_sat_cnt"] / acc["mid_cnt"]
                                      if has_mid else nan),
            "handover_specific_energy_mjkg": float(acc["handover_specific_energy_mjkg"]),
        }

    def terminal_summary(self):
        """Return endgame scalar metrics compatible with ``batch._terminal_fields``."""
        acc = self._acc
        nan = float("nan")
        cnt = acc["ho_cnt"]
        if cnt <= 0:
            return {
                "terminal_duration_s": nan,
                "terminal_peak_cmd_g": nan,
                "terminal_peak_act_g": nan,
                "terminal_fov_max_deg": nan,
                "terminal_lock_loss_pct": nan,
                "terminal_min_range_km": nan,
                "terminal_peak_alpha_deg": nan,
                "terminal_peak_beta_deg": nan,
                "terminal_fin_sat_pct": nan,
            }
        return {
            "terminal_duration_s": float(acc["ho_last_t"] - acc["ho_first_t"]),
            "terminal_peak_cmd_g": float(acc["ho_peak_cmd_g"]),
            "terminal_peak_act_g": float(acc["ho_peak_act_g"]),
            "terminal_fov_max_deg": math.degrees(acc["ho_fov_max"]),
            "terminal_lock_loss_pct": 100.0 * (1.0 - acc["ho_lock_cnt"] / cnt),
            "terminal_min_range_km": float(acc["ho_min_range"] * 1e-3),
            "terminal_peak_alpha_deg": math.degrees(acc["ho_peak_alpha"]),
            "terminal_peak_beta_deg": math.degrees(acc["ho_peak_beta"]),
            "terminal_fin_sat_pct": 100.0 * acc["ho_sat_cnt"] / cnt,
        }

    # --------------------------------------------------------
    def _before_step(self, t, y):
        """Sample all discrete modules at the start of an outer step (ZOH)."""
        r = y[SL_M_POS]
        v = y[SL_M_VEL]
        q_truth = y[SL_M_ATT]
        mass = float(y[SL_M_MASS.start])
        r_t_now = y[SL_T_POS]
        dx_r = float(r_t_now[0] - r[0])
        dy_r = float(r_t_now[1] - r[1])
        dz_r = float(r_t_now[2] - r[2])
        self._last_range_m = math.sqrt(dx_r * dx_r + dy_r * dy_r + dz_r * dz_r)

        # 0) Wind is sampled once per outer step and held (ZOH).
        if self.cfg.enable_wind:
            self._wind_zoh = self.wind.step(t, r, t - self._t_wind)
            self._t_wind = t

        # 1) Strapdown Navigation: body specific-force mechanisation rotated by
        # estimated attitude + GNSS update + transport delay.
        q_est_nav = q_truth if self.cfg.ideal_attitude else self.att.q
        fb_true = self._last_info.get("F_body")
        f_body_spec = (np.asarray(fb_true, dtype=float) / max(mass, 1.0)
                       if fb_true is not None else None)
        self.nav_est = self.nav.step(
            t, r, v, self._a_true,
            f_body_true=f_body_spec,
            q_est=q_est_nav,
            omega_true=y[SL_M_OMEGA],
            cg_pos=self.missile.cg_position(mass, separated=self._stage_separated))

        # 0b) Scramjet inlet unstart hysteresis latch (active post-boost in
        # ramjet flight envelope; triggers when total incidence > 10 deg and
        # recovers only once incidence drops below 7 deg).
        mach_now = float(self._last_info.get("mach", 0.0))
        alt_now = float(self._last_info.get("alt", 0.0))
        q_now_in = float(self._last_info.get("q_dyn", 0.0))
        in_ramjet_env = (self._stage_separated
                         and C.RAMJET_MACH_MIN <= mach_now <= C.RAMJET_MACH_MAX
                         and alt_now < C.RAMJET_ALT_CUTOFF
                         and q_now_in > C.RAMJET_Q_MIN)
        theta_inc = math.hypot(float(self._last_info.get("alpha", 0.0)),
                               float(self._last_info.get("beta", 0.0)))
        if not in_ramjet_env:
            self._inlet_unstart = False
        elif not self._inlet_unstart and theta_inc > C.INLET_UNSTART_ALPHA_ON:
            self._inlet_unstart = True
        elif self._inlet_unstart and theta_inc < C.INLET_UNSTART_ALPHA_OFF:
            self._inlet_unstart = False

        # Time-aligned missile state for seeker fusion & handover checks:
        # compensates the 50 ms navigation transport delay (~135 m at M 9)
        # using onboard velocity and measured acceleration.
        dt_nav = max(float(t) - float(self.nav_est.timestamp), 0.0)
        a_nav_est = MU.clip_norm(
            MU.quat_rotate(q_est_nav, self.nav.last_accel_body_meas)
            + MU.gravity_eci(self.nav_est.r_eci), 45.0 * C.G0)
        r_nav_now = (self.nav_est.r_eci + self.nav_est.v_eci * dt_nav
                     + 0.5 * a_nav_est * dt_nav * dt_nav)
        v_nav_now = self.nav_est.v_eci + a_nav_est * dt_nav
        self._nav_aligned = C.NavEstimate(
            r_eci=r_nav_now, v_eci=v_nav_now, timestamp=float(t))

        # 1b) Attitude aiding: star fix plus GNSS heading correction.  The
        # star fix also drives the gyro-bias estimate fed to the 12-state INS.
        if (not self.cfg.ideal_attitude and self.cfg.enable_attitude_aid
                and self.scheduler.due("star", t)):
            dt_star = max(float(t) - self._t_star, C.DT_SEEKER)
            q_fix = self.star.measure(q_truth)
            if q_fix is not None:
                self.att.star_update(q_fix, dt_star)
                self._t_star_fix = float(t)
                self.nav.set_gyro_bias(self.att.b_g)
            elif (C.GNSS_ATT_AID
                  and t - self._t_star_fix > 3.0 * C.STAR_PERIOD
                  and MU.norm3(self.nav_est.v_eci) > 1.0):
                # Star tracker blinded: fall back to the GNSS ground-track.
                self.att.course_update(
                    self.nav_est.v_eci, MU.local_up(r),
                    float(self._last_info.get("beta", 0.0)),
                    C.GNSS_ATT_AID_GAIN, C.GNSS_ATT_AID_BETA_MAX)
            self._t_star = float(t)

        if self.cfg.ideal_attitude:
            q_ctrl = q_truth
            omega_ctrl = y[SL_M_OMEGA]
        else:
            q_ctrl = self.att.q
            omega_ctrl = self.omega_meas
        self._seeker_updated = self.scheduler.due("seeker", t)
        if self._seeker_updated:
            # Midcourse seeker standby: outside 120 km (>2.4x max lock range)
            # with zero false-lock rate, no detection is physically possible.
            if (self._last_range_m > 120000.0
                    and self.cfg.seeker_false_lock_rate == 0.0
                    and self.cfg.telemetry_profile != "full"):
                self.seeker_meas = None
            else:
                decoy_now = self.target.decoy_state(
                    t, y[SL_T_POS], y[SL_T_VEL], r)
                self.seeker_meas = self.seeker.measure(
                    t, r, v, q_ctrl, y[SL_T_POS], y[SL_T_VEL],
                    wall_temp_k=self._wall_temp_k,
                    decoy_state=decoy_now,
                    tracked_vel=self.tracker.velocity())
            # A false detection can set is_locked=True at any range; only
            # count a first lock when the measured range is inside the
            # physical dual-mode acquisition range.
            max_phys_rng = max(self.seeker.lock_range,
                               getattr(self.seeker, "last_lock_range",
                                       self.seeker.lock_range))
            if (self.seeker_meas is not None and self.seeker_meas.is_locked
                    and getattr(self.seeker_meas, "confirmed", True)
                    and self.first_lock_time is None
                    and self.seeker_meas.range <= 1.10 * max_phys_rng):
                self.first_lock_time = float(t)
                self.first_lock_range = float(self.seeker_meas.range)
                self.first_lock_fov = float(self.seeker_meas.fov_angle)

        # 2b) Target tracker: propagate every step, fuse time-aligned missile
        # position/velocity + seeker LOS/range/Doppler range-rate on fresh lock.
        self.tracker.predict(t)
        if self._seeker_updated and self.seeker_meas is not None:
            self.tracker.update(self.seeker_meas,
                                self._nav_aligned.r_eci,
                                self._nav_aligned.v_eci)

        # 2c) Midcourse datalink with latency compensation and packet loss.
        # Once the seeker is actively tracking in terminal phase, suppress the
        # coarser offboard datalink so it cannot pull the seeker track off.
        seeker_active_terminal = bool(
            self.phase == "terminal" and self.seeker_meas is not None
            and self.seeker_meas.is_locked)
        while self._dl_queue and self._dl_queue[0][0] <= t + 1e-12:
            _, z_r, z_v, sp, sv, dl_lat = self._dl_queue.pop(0)
            if not seeker_active_terminal:
                self.tracker.update_position_velocity(
                    z_r, z_v, sp, sv, latency=dl_lat)
        if self.cfg.datalink_period > 0.0 and self.scheduler.due("datalink", t):
            sp = max(self.cfg.datalink_pos_sigma
                     * self.cfg.sensor_noise_scale, 0.0)
            sv = max(self.cfg.datalink_vel_sigma
                     * self.cfg.sensor_noise_scale, 0.0)
            z_r = y[SL_T_POS] + self._datalink_rng.normal(0.0, sp, 3)
            z_v = y[SL_T_VEL] + self._datalink_rng.normal(0.0, sv, 3)
            lost = self._datalink_rng.rand() < self.cfg.datalink_loss_prob
            if not lost:
                dl_lat = max(self.cfg.datalink_latency, 0.0)
                self._dl_queue.append(
                    (t + dl_lat, z_r, z_v, sp, sv, dl_lat))

        # 3) Guidance, handover and thrust control.  Guidance sees the tracked
        # target estimate, never the integrated truth state.
        if self.scheduler.due("guidance", t):
            self._guidance_step(t, y, self.tracker.estimate(), q_ctrl)
            self.throttle_cmd = self.thrust_ctrl.update(
                self.cfg.dt_guidance,
                float(self._last_info.get("mach", 0.0)),
                float(self._last_info.get("alt", 0.0)),
                float(self._last_q_dyn), self.phase,
                heat_flux_mw=self._heat_flux_mw)

        # 4) Autopilot and fin mixer.
        if self.scheduler.due("autopilot", t):
            outer_dt = float(self._step_size(t, y))
            if outer_dt > 0.015 and self._t_ap >= 0.0:
                dt_ap = min(max(float(t) - self._t_ap, self.cfg.dt_autopilot),
                            0.010)
            else:
                dt_ap = self.cfg.dt_autopilot
            self._t_ap = float(t)
            # Optional 1st elastic body bending mode + 22 Hz biquad notch filter.
            if self.cfg.enable_flex_mode:
                d_p_app = 0.5 * (self._fins_zoh[2] + self._fins_zoh[3])
                d_y_app = 0.5 * (self._fins_zoh[0] + self._fins_zoh[1])
                w_flex = self._flex_plant.step(
                    d_p_app, d_y_app, self._last_q_dyn, dt_ap)
                omega_ctrl = self._flex_notch.update(
                    np.asarray(omega_ctrl, dtype=float) + w_flex)
            # Use measured body-frame specific force from the strapdown IMU
            # (with accelerometer bias, scale error, noise and lever-arm) rather
            # than leaking truth F_body into the n_z feedback loop.
            load_body = None
            if self.nav.initialized:
                load_body = self.nav.last_accel_body_meas / C.G0
            elif self._last_info.get("F_body") is not None and mass > 1.0:
                load_body = np.asarray(self._last_info["F_body"], dtype=float) / (mass * C.G0)
            # Dead time of the command computed now: it is applied on the first
            # outer-step boundary at or after control_delay, so the predictor
            # horizon is that whole number of outer steps.
            delay = max(float(self.cfg.control_delay), 0.0)
            predict_horizon = ((math.ceil(delay / outer_dt - 1e-12) * outer_dt)
                               if delay > 0.0 else 0.0)
            # Air state for the predictor (same wind convention as the plant).
            v_air = MU.atmosphere_relative_velocity(r, v) - self._wind_zoh
            speed_air = MU.norm3(v_air)
            alt_air = max(MU.altitude(r), 0.0)
            if FC.NUMBA_AVAILABLE:
                _, _, _, sound_spd = FC.atmosphere(alt_air)
            else:
                sound_spd = get_atmosphere(alt_air).sound_speed
            mach_air = speed_air / max(float(sound_spd), 1e-6)
            virtual = self.autopilot.update(
                t, q_ctrl, omega_ctrl, self.guidance_cmd.a_cmd_eci, mass,
                self._last_q_dyn, self._last_cn_alpha,
                alpha_trim=self._last_alpha,
                beta_trim=float(self._last_info.get("beta", 0.0)),
                is_saturated=self.act_cmd.is_saturated,
                dt=dt_ap,
                load_body=load_body,
                predict_horizon=predict_horizon,
                mach=float(mach_air), speed=float(speed_air),
                v_air_eci=v_air, applied_fins=self._fins_zoh)
            self.act_cmd = self.fin_mixer.mix(
                virtual, dt=dt_ap, q_dyn=self._last_q_dyn)
            self._fin_delay.append(
                (float(t), self.act_cmd.delta_fins.copy()))

        # Control delay line: latch the newest command whose transport delay
        # has elapsed.  Runs every outer step, so the dead time is not
        # quantised to the autopilot period.
        ready = float(t) - max(float(self.cfg.control_delay), 0.0)
        while (len(self._fin_delay) >= 2
               and self._fin_delay[1][0] <= ready + 1e-12):
            self._fin_delay.pop(0)
        if self._fin_delay and self._fin_delay[0][0] <= ready + 1e-12:
            self._fins_zoh[:] = self._fin_delay[0][1]

        # 5) Telemetry & O(1) running stage/terminal statistics.
        if self.scheduler.due("log", t):
            self._update_running_stats(t, y)
            if self.telemetry.enabled:
                self._log(t, y)

    # --------------------------------------------------------
    def _after_step(self, t, y, dy):
        """Keep the integrated state inside its physical manifold."""
        q = y[SL_M_ATT]
        n = math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3])
        if n > 0.0:
            y[SL_M_ATT] = MU.quat_hemisphere(q / n, self._q_ref)
            self._q_ref = y[SL_M_ATT].copy()
        mass = float(y[SL_M_MASS.start])
        # Discrete Stage-1 solid booster casing jettison at burnout.
        if not self._stage_separated and float(t) >= C.BOOST_SEP_TIME:
            mass = max(mass - C.STAGE1_DRY_MASS, self.missile.dry_mass)
            y[SL_M_MASS.start] = mass
            self._stage_separated = True
        if mass < self.missile.dry_mass:
            y[SL_M_MASS.start] = self.missile.dry_mass
        elif mass > self.missile.mass0:
            y[SL_M_MASS.start] = self.missile.mass0

        # Advance 1D transient thin-wall nose-cap temperature T_w(t).
        dt_th = float(t) - self._t_thermal
        if dt_th > 0.0:
            r_cur = y[SL_M_POS]
            v_cur = y[SL_M_VEL]
            v_air_cur = MU.atmosphere_relative_velocity(r_cur, v_cur) - self._wind_zoh
            spd_cur = MU.norm3(v_air_cur)
            alt_cur = max(MU.altitude(r_cur), 0.0)
            mach_cur = float(self._last_info.get("mach", 0.0))
            (self._wall_temp_k, self._heat_flux_mw,
             self._wall_temp_eq_k, _) = step_transient_wall_temp(
                self._wall_temp_k, alt_cur, spd_cur, mach_cur, dt_th)
            self._t_thermal = float(t)

        # IMU: measure the body rate and propagate the attitude estimate.
        if not self.cfg.ideal_attitude:
            dt = float(t - self._t_imu)
            if dt > 0.0:
                self.omega_meas = self.imu.gyro(y[SL_M_OMEGA], dt)
                self.att.propagate(self.omega_meas, dt)
                self._t_imu = float(t)

        if not np.all(np.isfinite(y)):
            raise FloatingPointError("Integration state contains NaN/Inf at t=%.6f" % t)
        self._a_true = np.asarray(dy[SL_M_VEL], dtype=float).copy()

    # --------------------------------------------------------
    def _guidance_step(self, t, y, target_state, q):
        """Phase state machine and guidance command computation."""
        r = y[SL_M_POS]
        v = y[SL_M_VEL]
        speed = MU.norm3(v)

        if self.phase == "boost":
            if t >= BOOST_END_TIME or (speed > 1700.0 and MU.altitude(r) > 20000.0):
                self.phase = "midcourse"

        if self.phase == "boost":
            cmd = self.boost.compute(
                t, self.nav_est, target_state, q, self.seeker_meas)
            self.guidance_cmd = C.GuidanceCommand(
                a_cmd_eci=MU.clip_norm(cmd.a_cmd_eci, C.MAX_LOAD_G * C.G0),
                phase="boost")
            return

        a_mid = self.midcourse.compute(
            t, self.nav_est, target_state, q, self.seeker_meas)

        # Handover gates use the time-aligned navigation estimate (no 135 m skew).
        nav_ho = getattr(self, "_nav_aligned", self.nav_est)
        m_state_obj = self.missile.state_at(
            nav_ho.r_eci, nav_ho.v_eci, q, y[SL_M_OMEGA],
            float(y[SL_M_MASS.start]))
        aero = {"q_dyn": self._last_q_dyn, "CN_ALPHA": self._last_cn_alpha}
        is_ok, ho_info = self.handover.check(
            t, m_state_obj, target_state, self.seeker_meas, aero)
        self.handover_info = dict(ho_info)
        if is_ok and self.handover_trigger is None:
            self.handover_trigger = dict(ho_info)
            self.handover_trigger["t"] = float(t)

        # Only run terminal guidance once inside handover preparation range or
        # after trigger, so 600 s of midcourse noise never pollutes terminal state.
        if self.handover.triggered or is_ok or ho_info["range"] <= 35000.0:
            a_term_vec = self.terminal.compute(
                t, self.nav_est, target_state, q, self.seeker_meas,
                target_acc=self.tracker.acceleration()).a_cmd_eci
        else:
            a_term_vec = a_mid.a_cmd_eci
        a_cmd, triggered, _ = self.handover.update(
            t, is_ok, a_mid.a_cmd_eci, a_term_vec)

        if triggered:
            self.phase = "terminal"
            self.handover_flag = 1.0
        # Terminal keeps the airframe lift capability; boost/midcourse stay on
        # the lower navigation limit (see config).
        n_lim = (C.MAX_LOAD_TERMINAL_G if self.phase == "terminal"
                 else C.MAX_LOAD_G)
        self.guidance_cmd = C.GuidanceCommand(
            a_cmd_eci=MU.clip_norm(np.asarray(a_cmd, dtype=float), n_lim * C.G0),
            phase=self.phase)

    # --------------------------------------------------------
    def _log(self, t, y):
        """Write one telemetry frame directly into pre-allocated ``_log_buf``."""
        if not self.telemetry.enabled:
            return
        buf = self._log_buf
        info = self._last_info
        r = y[SL_M_POS]
        v = y[SL_M_VEL]
        q = y[SL_M_ATT]
        omega = y[SL_M_OMEGA]
        mass = float(y[SL_M_MASS.start])
        r_t = y[SL_T_POS]
        v_t = y[SL_T_VEL]
        lat, lon, alt = MU.eci_to_llh(r, t)

        rho = r_t - r
        R = MU.norm3(rho)
        u = MU.normalize(rho)
        range_rate = float(np.dot(v_t - v, u))
        speed = MU.norm3(v)
        lead_angle = MU.angle_between(v, u) if speed > 1.0 else np.pi
        dh = alt - MU.altitude(r_t)
        nav_err = MU.norm3(self.nav_est.r_eci - r)
        tgt_est_err = MU.norm3(self.tracker.position() - r_t)

        Fb = info.get("F_body")
        if Fb is None:
            Fb = np.zeros(3)
        m = max(mass, 1e-6)
        inv_m = 1.0 / m
        inv_mg = 1.0 / (m * C.G0)
        a_act = MU.quat_rotate(q, Fb) * inv_m

        a_cmd = self.guidance_cmd.a_cmd_eci
        fins = self.act_cmd.delta_fins
        seeker = self.seeker_meas
        fov_angle = float(seeker.fov_angle) if seeker is not None else 0.0
        locked = 1.0 if (seeker is not None and seeker.is_locked) else 0.0

        # ---- Basic columns [0..46] (matches TELEMETRY_BASIC_COLUMNS[1:]) ----
        buf[0] = r[0]; buf[1] = r[1]; buf[2] = r[2]
        buf[3] = v[0]; buf[4] = v[1]; buf[5] = v[2]
        buf[6] = r_t[0]; buf[7] = r_t[1]; buf[8] = r_t[2]
        buf[9] = v_t[0]; buf[10] = v_t[1]; buf[11] = v_t[2]
        buf[12] = mass
        buf[13] = float(info["mach"])
        buf[14] = float(info["q_dyn"])
        buf[15] = alt
        buf[16] = lat
        buf[17] = lon
        buf[18] = float(info["alpha"])
        buf[19] = float(info["beta"])
        buf[20] = Fb[0] * inv_mg
        buf[21] = Fb[1] * inv_mg
        buf[22] = Fb[2] * inv_mg
        buf[23] = a_cmd[0]; buf[24] = a_cmd[1]; buf[25] = a_cmd[2]
        buf[26] = a_act[0]; buf[27] = a_act[1]; buf[28] = a_act[2]
        buf[29] = fins[0]; buf[30] = fins[1]; buf[31] = fins[2]; buf[32] = fins[3]
        buf[33] = 1.0 if self.act_cmd.is_saturated else 0.0
        buf[34] = nav_err
        buf[35] = R
        buf[36] = range_rate
        buf[37] = locked
        buf[38] = fov_angle
        buf[39] = PHASE_CODE.get(self.phase, 1.0)
        buf[40] = self.handover_flag
        buf[41] = dh
        buf[42] = lead_angle
        buf[43] = omega[0]; buf[44] = omega[1]; buf[45] = omega[2]
        buf[46] = tgt_est_err

        # Early return for "basic" profile: skip all 104 extended column computations!
        if self.telemetry.n_cols <= len(C.TELEMETRY_BASIC_COLUMNS):
            self.telemetry.send(t, buf)
            return

        # ---- Extended observables [47..150] (only computed for "full" profile) ----
        if FC.NUMBA_AVAILABLE:
            _, _, air_rho, sound_spd = FC.atmosphere(max(alt, 0.0))
        else:
            atm = get_atmosphere(alt)
            air_rho, sound_spd = atm.density, atm.sound_speed

        # ECI -> ECEF (Earth rotation) for position and velocity.
        theta = C.OMEGA_EARTH * t
        ct, st = math.cos(theta), math.sin(theta)
        we = C.OMEGA_EARTH
        vr0 = v[0] + we * r[1]
        vr1 = v[1] - we * r[0]
        vr2 = v[2]
        buf[47] = ct * r[0] + st * r[1]
        buf[48] = -st * r[0] + ct * r[1]
        buf[49] = r[2]
        buf[50] = ct * vr0 + st * vr1
        buf[51] = -st * vr0 + ct * vr1
        buf[52] = vr2

        # Local NED frame at the missile position (ENU columns -> ECI).
        enu = MU.local_enu_dcm(lat, lon, t)
        ned_dcm = np.vstack((enu[:, 1], enu[:, 0], -enu[:, 2]))
        m_vned = ned_dcm.dot(v)
        buf[53] = m_vned[0]; buf[54] = m_vned[1]; buf[55] = m_vned[2]

        # Body -> ECI DCM (reuse cached dcm_be from continuous dynamics).
        dcm_be = info.get("dcm_be")
        if dcm_be is None:
            dcm_be = MU.quat_to_dcm(q)
        c_bn = ned_dcm.dot(dcm_be)
        yaw = math.atan2(c_bn[1, 0], c_bn[0, 0])
        pitch = math.asin(float(np.clip(-c_bn[2, 0], -1.0, 1.0)))
        roll = math.atan2(c_bn[2, 1], c_bn[2, 2])
        buf[56] = q[0]; buf[57] = q[1]; buf[58] = q[2]; buf[59] = q[3]
        buf[60] = math.degrees(roll)
        buf[61] = math.degrees(pitch)
        buf[62] = math.degrees(yaw)

        v_air = MU.atmosphere_relative_velocity(r, v)
        airspeed = MU.norm3(v_air)
        gamma = math.asin(float(np.clip(-m_vned[2] / max(speed, 1e-6),
                                        -1.0, 1.0)))
        chi = math.atan2(m_vned[1], m_vned[0])
        buf[63] = math.degrees(gamma)
        buf[64] = math.degrees(chi)
        buf[65] = speed
        buf[66] = airspeed
        buf[67] = float(air_rho)
        buf[68] = float(sound_spd)
        buf[69] = Fb[0]; buf[70] = Fb[1]; buf[71] = Fb[2]

        a_cmd_b = MU.quat_rotate_inv(q, a_cmd)
        n_cmd_g = MU.norm3(a_cmd) / C.G0
        buf[72] = a_cmd_b[0]; buf[73] = a_cmd_b[1]; buf[74] = a_cmd_b[2]
        buf[75] = n_cmd_g

        # LOS geometry (reuse rho, R, u, range_rate already computed above).
        v_rel = v_t - v
        inv_r2 = 1.0 / max(R * R, 1e-12)
        los_rate = np.cross(rho, v_rel) * inv_r2
        vc = max(-range_rate, 50.0)
        t_go = max(R / vc, 0.05)
        buf[76] = u[0]; buf[77] = u[1]; buf[78] = u[2]
        buf[79] = los_rate[0]; buf[80] = los_rate[1]; buf[81] = los_rate[2]
        buf[82] = t_go
        buf[83] = vc

        nav_r = self.nav_est.r_eci
        nav_v = self.nav_est.v_eci
        buf[84] = nav_r[0]; buf[85] = nav_r[1]; buf[86] = nav_r[2]
        buf[87] = nav_v[0]; buf[88] = nav_v[1]; buf[89] = nav_v[2]
        buf[90] = nav_r[0] - r[0]; buf[91] = nav_r[1] - r[1]; buf[92] = nav_r[2] - r[2]
        buf[93] = rho[0]; buf[94] = rho[1]; buf[95] = rho[2]

        t_lat, t_lon, t_alt = MU.eci_to_llh(r_t, t)
        buf[96] = t_lat; buf[97] = t_lon; buf[98] = t_alt

        # Reuse target acceleration from fused RK4 average derivative when valid.
        if self._has_rk4_favg:
            buf[99] = self._rk4_f_avg[17]
            buf[100] = self._rk4_f_avg[18]
            buf[101] = self._rk4_f_avg[19]
        else:
            dy_t = self.target.derivatives(t, np.concatenate((r_t, v_t)), r)
            buf[99] = dy_t[3]; buf[100] = dy_t[4]; buf[101] = dy_t[5]

        if seeker is not None:
            buf[102] = float(seeker.range)
            buf[103] = float(seeker.range_rate)
            s_los = seeker.los_angle
            s_lr = seeker.los_rate
            buf[122] = s_los[0]; buf[123] = s_los[1]; buf[124] = s_los[2]
            buf[125] = s_lr[0]; buf[126] = s_lr[1]; buf[127] = s_lr[2]
            aspect_deg = float(getattr(seeker, "aspect_deg", 0.0))
            target_rcs = float(getattr(seeker, "target_rcs", C.TARGET_RCS))
            radar_snr = float(getattr(seeker, "radar_snr_db", -60.0))
            ir_snr = float(getattr(seeker, "ir_snr_db", -60.0))
            seeker_az_deg = math.degrees(float(getattr(seeker, "az_body", 0.0)))
            seeker_el_deg = math.degrees(float(getattr(seeker, "el_body", 0.0)))
            decoy_active = 1.0 if getattr(seeker, "decoy_active", False) else 0.0
            decoy_az_deg = math.degrees(float(getattr(seeker, "decoy_az_body", 0.0)))
            decoy_el_deg = math.degrees(float(getattr(seeker, "decoy_el_body", 0.0)))
        else:
            buf[102] = 0.0; buf[103] = 0.0
            buf[122] = 0.0; buf[123] = 0.0; buf[124] = 0.0
            buf[125] = 0.0; buf[126] = 0.0; buf[127] = 0.0
            aspect_deg = 0.0
            target_rcs = C.TARGET_RCS
            radar_snr = -60.0
            ir_snr = -60.0
            seeker_az_deg = 0.0
            seeker_el_deg = 0.0
            decoy_active = 0.0
            decoy_az_deg = 0.0
            decoy_el_deg = 0.0

        # Body axes in ECI (columns of dcm_be).
        buf[104] = dcm_be[0, 0]; buf[105] = dcm_be[1, 0]; buf[106] = dcm_be[2, 0]
        buf[107] = dcm_be[0, 1]; buf[108] = dcm_be[1, 1]; buf[109] = dcm_be[2, 1]
        buf[110] = dcm_be[0, 2]; buf[111] = dcm_be[1, 2]; buf[112] = dcm_be[2, 2]
        mb = info.get("M_body")
        if mb is not None:
            buf[113] = mb[0]; buf[114] = mb[1]; buf[115] = mb[2]
        else:
            buf[113] = 0.0; buf[114] = 0.0; buf[115] = 0.0

        # Target ECEF position and velocity.
        vtr0 = v_t[0] + we * r_t[1]
        vtr1 = v_t[1] - we * r_t[0]
        vtr2 = v_t[2]
        buf[116] = ct * r_t[0] + st * r_t[1]
        buf[117] = -st * r_t[0] + ct * r_t[1]
        buf[118] = r_t[2]
        buf[119] = ct * vtr0 + st * vtr1
        buf[120] = -st * vtr0 + ct * vtr1
        buf[121] = vtr2

        if FC.NUMBA_AVAILABLE:
            gx, gy, gz = FC.gravity_xyz(r[0], r[1], r[2])
            buf[128] = gx; buf[129] = gy; buf[130] = gz
        else:
            grav = MU.gravity_eci(r)
            buf[128] = grav[0]; buf[129] = grav[1]; buf[130] = grav[2]

        # Reuse cached aerothermal flux/equilibrium temp from _after_step (avoid 2nd Newton solve).
        if t > 0.0 and self._t_thermal > 0.0:
            heat_flux_mw = float(self._heat_flux_mw)
            wall_temp_eq_k = float(self._wall_temp_eq_k)
        else:
            heat_flux_mw, wall_temp_eq_k, _ = aerothermal_state(
                alt, airspeed, float(info["mach"]))
        wall_temp_k = float(self._wall_temp_k)
        separated_now = float(t) >= C.BOOST_SEP_TIME
        cg_pos = float(self.missile.cg_position(mass, separated=separated_now))
        cp_pos = float(cg_pos + static_margin(float(info["mach"]), cg_pos))
        imm_probs = getattr(self.tracker, "mode_probs", None)
        if imm_probs is not None:
            imm_p_cv = float(imm_probs[0])
            imm_p_ca = float(imm_probs[1])
            imm_p_ct = float(imm_probs[2])
        else:
            imm_p_cv, imm_p_ca, imm_p_ct = 0.34, 0.33, 0.33

        buf[131] = heat_flux_mw
        buf[132] = wall_temp_k
        buf[133] = aspect_deg
        buf[134] = target_rcs
        buf[135] = radar_snr
        buf[136] = ir_snr
        buf[137] = seeker_az_deg
        buf[138] = seeker_el_deg
        buf[139] = wall_temp_eq_k
        buf[140] = 1.0 if self._inlet_unstart else 0.0
        buf[141] = 1.0 if self._stage_separated else 0.0
        buf[142] = cg_pos
        buf[143] = cp_pos
        buf[144] = decoy_active
        buf[145] = decoy_az_deg
        buf[146] = decoy_el_deg
        buf[147] = imm_p_cv
        buf[148] = imm_p_ca
        buf[149] = imm_p_ct
        buf[150] = float(self._live_fuze_pk)

        self.telemetry.send(t, buf)

    # --------------------------------------------------------
    def _step_size(self, t, y):
        """Phase-adaptive multi-rate outer step: relax smooth level midcourse cruise."""
        if self.phase == "midcourse":
            if (self.cfg.adaptive_midcourse_step
                    and float(t) >= 40.0
                    and self._last_range_m > 80000.0
                    and not getattr(self.midcourse, "descent_active", False)
                    and not self._inlet_unstart
                    and not self.act_cmd.is_saturated
                    and abs(self._last_alpha) < 0.11):
                ac = self.guidance_cmd.a_cmd_eci
                ac_sq = float(ac[0] * ac[0] + ac[1] * ac[1] + ac[2] * ac[2])
                om = y[SL_M_OMEGA]
                om_sq = float(om[0] * om[0] + om[1] * om[1] + om[2] * om[2])
                if ac_sq < (1.5 * C.G0) ** 2 and om_sq < 0.25 * 0.25:
                    return float(self.cfg.midcourse_cruise_step)
            return float(self.cfg.midcourse_max_step)
        return float(self.cfg.max_step)

    # --------------------------------------------------------
    def run(self):
        t_start = time.time()
        self.scheduler.reset()
        # First datalink fix arrives one period after launch (the pre-launch cue
        # already covers t = 0).
        self.scheduler.next_t["datalink"] = max(self.cfg.datalink_period, 0.0)

        def ev_miss(t, y):
            return self._event_miss(t, y)
        ev_miss.terminal = True
        ev_miss.direction = 1

        def ev_ground(t, y):
            return self._event_ground(t, y)
        ev_ground.terminal = True
        ev_ground.direction = -1

        sol = INT.integrate(
            self._rhs, (0.0, self.cfg.t_end), self.y0,
            step=self._step_size,
            events=[ev_miss, ev_ground],
            before_step=self._before_step,
            after_step=self._after_step,
            max_steps=self.cfg.max_integration_steps,
            stepper=(self._stepper if FC.NUMBA_AVAILABLE else None))
        self.sol = sol
        self.cpu_time = time.time() - t_start

        # Event interpolation gives the exact closest-approach point.
        if sol.t_events is not None:
            for i, ev_name in enumerate(["miss", "ground"]):
                if i < len(sol.t_events) and len(sol.t_events[i]) > 0:
                    t_ev = float(sol.t_events[i][0])
                    y_ev = sol.y_events[i][0]
                    dist = float(np.linalg.norm(y_ev[SL_T_POS] - y_ev[SL_M_POS]))
                    if ev_name == "miss" or np.isnan(self.miss_distance):
                        self.miss_distance = dist
                        self.miss_time = t_ev
                        self.fuze_report = proximity_fuze_lethality(
                            y_ev[SL_M_POS], y_ev[SL_M_VEL], y_ev[SL_M_ATT],
                            y_ev[SL_T_POS], y_ev[SL_T_VEL])
                        self._live_fuze_pk = float(self.fuze_report["pk_fuze"])
                        self._update_running_stats(t_ev, y_ev)
                        # Append exact closest-approach state to telemetry so
                        # downstream binary/CSV/web payloads match the event locator
                        # instead of stopping up to 10 ms (~30 m) early.
                        if (self.telemetry.enabled
                                and t_ev > self.telemetry._last_time + 1e-7):
                            self._rhs(t_ev, y_ev)
                            self._log(t_ev, y_ev)

        # Fallback if no event fired: minimum logged / observed range.
        if np.isnan(self.miss_distance):
            if self.telemetry.n > 0:
                rng = self.telemetry.get("range")
                idx = int(np.argmin(rng))
                self.miss_distance = float(rng[idx])
                self.miss_time = float(self.telemetry.get("time")[idx])
            elif math.isfinite(self._min_range_m):
                self.miss_distance = float(self._min_range_m)
                self.miss_time = float(self._min_range_t)

        if self.cfg.verbose:
            print("=" * 64)
            print("Simulation: %s" % ("success" if sol.success else "failed: " + sol.message))
            cruise_str = (" / cruise %.4f s" % self.cfg.midcourse_cruise_step
                          if self.cfg.adaptive_midcourse_step else "")
            print("Integrator: native RK4 (%s) | step: %.4f s (midcourse %.4f s%s) | RHS calls: %d"
                  % ("fused nogil Numba" if FC.NUMBA_AVAILABLE else "Python",
                     self.cfg.max_step, self.cfg.midcourse_max_step, cruise_str,
                     sol.nfev))
            print("CPU time: %.2f s" % self.cpu_time)
            print("Miss distance: %.2f m @ t=%.3f s" % (self.miss_distance, self.miss_time))
            if self.fuze_report is not None:
                fr = self.fuze_report
                print("Proximity fuze: lead %.2f ms (standoff %.1f m) | "
                      "frag density %.2f /m^2 | Pk(fuze)=%.1f%% vs Pk(Carleton)=%.1f%%"
                      % (fr["tau_fuze_ms"], fr["standoff_m"], fr["frag_density_m2"],
                         100.0 * fr["pk_fuze"], 100.0 * fr["pk_carleton"]))
            print("Telemetry frames: %d" % self.telemetry.n)
            print("=" * 64)
        return sol

    # --------------------------------------------------------
    def save(self, out_dir=None, write_csv=False):
        out_dir = out_dir or self.cfg.output_dir
        if not os.path.isdir(out_dir):
            os.makedirs(out_dir)
        t_io = time.time()
        npz_path = self.telemetry.save_npz(os.path.join(out_dir, "telemetry.npz"))
        dt_npz = time.time() - t_io
        print("Telemetry saved (binary NPZ, %.2f s): %s"
              % (dt_npz, os.path.abspath(npz_path)))
        if write_csv:
            t_csv = time.time()
            csv_path = self.telemetry.save_csv(os.path.join(out_dir, "telemetry.csv"))
            print("Telemetry CSV exported (%.2f s): %s"
                  % (time.time() - t_csv, os.path.abspath(csv_path)))
            return csv_path
        return npz_path


# ============================================================
# Plotting: one compact six-panel dashboard
# ============================================================
def plot_results(sim, out_dir=None):
    """Write the dependency-free interactive HTML dashboard."""
    from visualization import write_dashboard
    path = write_dashboard(sim, out_dir)
    return [path] if path else []


# ============================================================
# Step-size convergence study (Richardson extrapolation)
# ============================================================
def converged_miss_distance(cfg=None, scenario=None, factor=2.0, verbose=True,
                            levels=4):
    """Estimate the truncation-free miss distance from successive step levels.

    Runs the closed loop with sensor noise disabled at h, h/factor, ... for
    ``levels`` runs.  The observed order uses the two **finest** consecutive
    differences (the coarse levels are dominated by control-switch timing,
    which inflates the apparent order), then Richardson-extrapolates from the
    finest pair.

    Noise must be off: otherwise the levels differ by their stochastic
    realisation and the difference no longer measures discretisation error.
    Sampled-data periods (guidance/autopilot/seeker) are deliberately not
    scaled - they are part of the model, not of the integration.
    """
    base = cfg if cfg is not None else C.SimConfig()
    factor = float(factor)
    levels = int(levels)
    if factor <= 1.0:
        raise ValueError("factor must be > 1 (got %r)" % factor)
    if levels < 3:
        raise ValueError("levels must be >= 3")

    recs = []
    for level in range(levels):
        scale = 1.0 / factor ** level
        run_cfg = dataclasses.replace(
            base,
            max_step=base.max_step * scale,
            midcourse_max_step=base.midcourse_max_step * scale,
            adaptive_midcourse_step=False,
            telemetry_profile="none",
            max_steps=1,
            sensor_noise_scale=0.0,
            enable_plot=False,
            verbose=False,
        )
        sim = Simulation(run_cfg, scenario)
        sim.run()
        recs.append({
            "max_step": float(run_cfg.max_step),
            "midcourse_step": float(run_cfg.midcourse_max_step),
            "miss": float(sim.miss_distance),
            "miss_time": float(sim.miss_time),
        })
        del sim   # release state before the next level

    misses = [r["miss"] for r in recs]
    m_prev2, m_prev1, m_last = misses[-3], misses[-2], misses[-1]

    # Observed order from the two finest differences; fall back to the RK4
    # order if the sequence is not monotone (e.g. a step near a control switch).
    d1 = m_prev2 - m_prev1
    d2 = m_prev1 - m_last
    if (d1 != 0.0 and d2 != 0.0 and d1 * d2 > 0.0
            and abs(d2) < abs(d1)
            and np.isfinite(m_prev2) and np.isfinite(m_last)):
        p = math.log(abs(d1) / abs(d2)) / math.log(factor)
        p = min(max(p, 0.5), 8.0)
    else:
        p = 4.0
    r = factor ** p
    if np.isfinite(m_prev1) and np.isfinite(m_last):
        m_x = (r * m_last - m_prev1) / (r - 1.0)
        err = abs(m_last - m_prev1) / (r - 1.0)
    else:
        m_x = float("nan")
        err = float("nan")

    out = {
        "factor": factor,
        "levels": levels,
        "max_step": [r["max_step"] for r in recs],
        "midcourse_step": [r["midcourse_step"] for r in recs],
        "miss": misses,
        "miss_time": [r["miss_time"] for r in recs],
        "observed_order": p,
        "miss_richardson": m_x,
        "error_estimate": err,
    }

    if verbose:
        print("=" * 64)
        print("Step-size convergence (noise-free, factor %.2f)" % factor)
        for i, rec in enumerate(recs):
            print("  h = %.4f ms (mid %.4f ms) -> miss %12.4f m @ t=%.3f s"
                  % (1e3 * rec["max_step"], 1e3 * rec["midcourse_step"],
                     rec["miss"], rec["miss_time"]))
        print("  observed order p = %.2f" % p)
        print("  Richardson: %.6f m  (+/- %.6f m)" % (m_x, err))
        print("=" * 64)
    return out


# ============================================================
def main(argv=None):
    parser = argparse.ArgumentParser(description="2000 km-class hypersonic interceptor 6DOF simulation")
    parser.add_argument("--max-step", type=float, default=None,
                        help="boost/terminal outer step s")
    parser.add_argument("--midcourse-step", type=float, default=None,
                        help="midcourse outer step s")
    parser.add_argument("--no-adaptive-step", action="store_true",
                        help="disable phase-adaptive midcourse cruise step widening")
    parser.add_argument("--duration", type=float, default=None, help="simulation stop time s")
    parser.add_argument("--no-plot", action="store_true", help="skip plotting")
    parser.add_argument("--csv", action="store_true",
                        help="also export telemetry.csv alongside binary telemetry.npz")
    parser.add_argument("--boost-law", default="feasible",
                        choices=sorted(_BOOST_LAWS),
                        help="boost guidance law (comparison switch)")
    parser.add_argument("--midcourse-law", default="bezier",
                        choices=sorted(_MIDCOURSE_LAWS),
                        help="midcourse guidance law (comparison switch)")
    parser.add_argument("--terminal-law", default="zem_apn",
                        choices=sorted(_TERMINAL_LAWS),
                        help="terminal guidance law (comparison switch)")
    parser.add_argument("--control-law", default="scheduled",
                        choices=sorted(_CONTROL_LAWS),
                        help="attitude-control law (comparison switch)")
    parser.add_argument("--batch", type=int, default=None, help="Monte-Carlo batch cases")
    parser.add_argument("--workers", type=int, default=None, help="batch worker processes")
    parser.add_argument("--seed", type=int, default=2026, help="batch base seed")
    parser.add_argument("--converge", action="store_true",
                        help="step-size convergence + Richardson extrapolation of the miss distance")
    parser.add_argument("--converge-factor", type=float, default=2.0,
                        help="step refinement factor for --converge")
    parser.add_argument("--converge-levels", type=int, default=4,
                        help="number of step levels for --converge (>=3)")
    args = parser.parse_args(argv)

    C.validate_data()

    cfg = C.SimConfig()
    cfg.boost_law = args.boost_law
    cfg.midcourse_law = args.midcourse_law
    cfg.terminal_law = args.terminal_law
    cfg.control_law = args.control_law
    if args.max_step is not None:
        cfg.max_step = args.max_step
    if args.midcourse_step is not None:
        cfg.midcourse_max_step = args.midcourse_step
    if args.no_adaptive_step:
        cfg.adaptive_midcourse_step = False
    if args.duration is not None:
        cfg.t_end = args.duration
    cfg.enable_plot = not args.no_plot

    if args.converge:
        return converged_miss_distance(cfg, factor=args.converge_factor,
                                       levels=args.converge_levels)

    if args.batch is not None:
        import batch
        return batch.run_batch(
            args.batch, workers=args.workers, base_seed=args.seed, cfg=cfg,
            plot=cfg.enable_plot)

    sim = Simulation(cfg)
    sim.run()
    sim.save(write_csv=args.csv)
    if cfg.enable_plot:
        plot_results(sim)
    return sim


if __name__ == "__main__":
    main()
