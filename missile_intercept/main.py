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
from vehicle.missile import Missile
from vehicle.target import Target
from vehicle.atmosphere import get_atmosphere
from sensors.navigation import NavigationSystem
from sensors.seeker import Seeker
from sensors.target_tracker import TargetTracker
from sensors.imu import IMU, StarTracker, AttitudeEstimator
from vehicle.wind import WindModel
from state_schema import (SYSTEM_SCHEMA, SL_M_POS, SL_M_VEL, SL_M_ATT,
                          SL_M_OMEGA, SL_M_MASS, SL_T_POS, SL_T_VEL)
from control.autopilot import Autopilot
from control.fin_mixer import FinMixer
from control.thrust_controller import ThrustController
from guidance.boost_guidance import BoostGuidance
from guidance.midcourse_guidance import MidcourseGuidance
from guidance.terminal_guidance import TerminalGuidance
from guidance.handover_manager import HandoverManager

BOOST_END_TIME = C.BOOST_END_TIME
PHASE_CODE = {"boost": 0.0, "midcourse": 1.0, "terminal": 2.0}

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
        self.autopilot = Autopilot(self.cfg.dt_autopilot)
        self.fin_mixer = FinMixer(self.cfg.dt_autopilot)
        self.thrust_ctrl = ThrustController()
        self.throttle_cmd = 1.0
        self.boost = BoostGuidance()
        self.midcourse = MidcourseGuidance()
        self.terminal = TerminalGuidance()
        self.handover = HandoverManager()
        self.scheduler = MultiRateScheduler(self.cfg)
        columns = (C.TELEMETRY_COLUMNS if self.cfg.telemetry_profile == "full"
                   else C.TELEMETRY_BASIC_COLUMNS)
        self.telemetry = TelemetryLogger(self.cfg.max_steps, columns)

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
        # Estimated attitude/rate used by the control loop (IMU-propagated,
        # star-aided; the gyro bias is estimated alongside).
        self.att = AttitudeEstimator(q0)
        self.att_est = self.att.q
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
        if FC.NUMBA_AVAILABLE:
            (dy, alpha, beta, mach, q_dyn, alt, cn_a, Fb, Mb, dcm, mdot,
             thrust, phase_code) = FC.system_derivatives(
                float(t), np.ascontiguousarray(y), self._fins_zoh,
                self.missile.mass0, self.missile.dry_mass, self.missile.fuel0,
                self.missile.S, self.missile.L, float(self.throttle_cmd),
                float(self._wind_zoh[0]), float(self._wind_zoh[1]),
                float(self._wind_zoh[2]),
                float(self.target.evade_g), float(self.target.maneuver_dist),
                float(self.target.evade_phase))
            self._last_info = {
                "alt": float(alt), "mach": float(mach),
                "q_dyn": float(q_dyn), "alpha": float(alpha),
                "beta": float(beta), "thrust": float(thrust),
                "mdot": float(mdot), "CN_ALPHA": float(cn_a),
                "F_body": Fb, "M_body": Mb, "dcm_be": dcm,
                "phase": {-1: "coast", 0: "boost", 1: "ramjet"}[int(phase_code)],
            }
            self._last_alpha = float(alpha)
            self._last_cn_alpha = float(cn_a)
            self._last_q_dyn = float(q_dyn)
            return dy

        dy_m, info = self.missile.derivatives(
            t, y[SL_M_STATE], self.act_cmd.delta_fins,
            throttle=self.throttle_cmd, wind=self._wind_zoh)
        self._last_info = info
        self._last_alpha = float(info["alpha"])
        self._last_cn_alpha = float(info["CN_ALPHA"])
        self._last_q_dyn = float(info["q_dyn"])

        dy_t = self.target.derivatives(t, y[SL_T_STATE], y[SL_M_POS])
        return np.concatenate((dy_m, dy_t))

    # --------------------------------------------------------
    def _before_step(self, t, y):
        """Sample all discrete modules at the start of an outer step (ZOH)."""
        r = y[SL_M_POS]
        v = y[SL_M_VEL]
        q_truth = y[SL_M_ATT]
        mass = float(y[SL_M_MASS.start])

        # 0) Wind is sampled once per outer step and held (ZOH).
        if self.cfg.enable_wind:
            self._wind_zoh = self.wind.step(t, r, t - self._t_wind)
            self._t_wind = t

        # 1) Navigation: INS prediction + GNSS update + transport delay.
        self.nav_est = self.nav.step(t, r, v, self._a_true)

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
        self.att_est = self.att.q

        if self.cfg.ideal_attitude:
            q_ctrl = q_truth
            omega_ctrl = y[SL_M_OMEGA]
        else:
            q_ctrl = self.att.q
            omega_ctrl = self.omega_meas
        self._seeker_updated = self.scheduler.due("seeker", t)
        if self._seeker_updated:
            self.seeker_meas = self.seeker.measure(
                t, r, v, q_ctrl, y[SL_T_POS], y[SL_T_VEL])
            # A false detection can set is_locked=True at any range; only
            # count a first lock when the measured range is inside the
            # physical dual-mode acquisition range.
            if (self.seeker_meas is not None and self.seeker_meas.is_locked
                    and getattr(self.seeker_meas, "confirmed", True)
                    and self.first_lock_time is None
                    and self.seeker_meas.range <= 1.10 * self.seeker.lock_range):
                self.first_lock_time = float(t)
                self.first_lock_range = float(self.seeker_meas.range)
                self.first_lock_fov = float(self.seeker_meas.fov_angle)

        # 2b) Target tracker: propagate every step, correct on a fresh lock.
        self.tracker.predict(t)
        if self._seeker_updated:
            self.tracker.update(self.seeker_meas, self.nav_est.r_eci)

        # 2c) Midcourse datalink with transport latency and packet loss.
        while self._dl_queue and self._dl_queue[0][0] <= t + 1e-12:
            _, z_r, z_v, sp, sv = self._dl_queue.pop(0)
            self.tracker.update_position_velocity(z_r, z_v, sp, sv)
        if self.cfg.datalink_period > 0.0 and self.scheduler.due("datalink", t):
            sp = max(self.cfg.datalink_pos_sigma
                     * self.cfg.sensor_noise_scale, 0.0)
            sv = max(self.cfg.datalink_vel_sigma
                     * self.cfg.sensor_noise_scale, 0.0)
            z_r = y[SL_T_POS] + self._datalink_rng.normal(0.0, sp, 3)
            z_v = y[SL_T_VEL] + self._datalink_rng.normal(0.0, sv, 3)
            lost = self._datalink_rng.rand() < self.cfg.datalink_loss_prob
            if not lost:
                self._dl_queue.append(
                    (t + max(self.cfg.datalink_latency, 0.0),
                     z_r, z_v, sp, sv))

        # 3) Guidance, handover and thrust control.  Guidance sees the tracked
        # target estimate, never the integrated truth state.
        if self.scheduler.due("guidance", t):
            self._guidance_step(t, y, self.tracker.estimate(), q_ctrl)
            self.throttle_cmd = self.thrust_ctrl.update(
                self.cfg.dt_guidance,
                float(self._last_info.get("mach", 0.0)),
                float(self._last_info.get("alt", 0.0)),
                float(self._last_q_dyn), self.phase)

        # 4) Autopilot and fin mixer.
        if self.scheduler.due("autopilot", t):
            load_body = None
            fb = self._last_info.get("F_body")
            if fb is not None and mass > 1.0:
                load_body = np.asarray(fb, dtype=float) / (mass * C.G0)
            virtual = self.autopilot.update(
                t, q_ctrl, omega_ctrl, self.guidance_cmd.a_cmd_eci, mass,
                self._last_q_dyn, self._last_cn_alpha,
                alpha_trim=self._last_alpha,
                beta_trim=float(self._last_info.get("beta", 0.0)),
                is_saturated=self.act_cmd.is_saturated,
                dt=self.cfg.dt_autopilot,
                load_body=load_body)
            self.act_cmd = self.fin_mixer.mix(virtual, dt=self.cfg.dt_autopilot)
            self._fins_zoh[:] = self.act_cmd.delta_fins

        # 5) Telemetry.
        if self.scheduler.due("log", t):
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
        if mass < self.missile.dry_mass:
            y[SL_M_MASS.start] = self.missile.dry_mass
        elif mass > self.missile.mass0:
            y[SL_M_MASS.start] = self.missile.mass0

        # IMU: measure the body rate and propagate the attitude estimate.
        if not self.cfg.ideal_attitude:
            dt = float(t - self._t_imu)
            if dt > 0.0:
                self.omega_meas = self.imu.gyro(y[SL_M_OMEGA], dt)
                self.att.propagate(self.omega_meas, dt)
                self.att_est = self.att.q
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
            self.guidance_cmd = self.boost.compute(
                t, self.nav_est, target_state, q, self.seeker_meas)
            return

        a_mid = self.midcourse.compute(
            t, self.nav_est, target_state, q, self.seeker_meas)
        a_term = self.terminal.compute(
            t, self.nav_est, target_state, q, self.seeker_meas)

        # Handover gates use the same delayed navigation estimate as guidance,
        # not the truth state (mass/attitude stay truth-based because they are
        # directly measured/known).
        m_state_obj = self.missile.state_at(
            self.nav_est.r_eci, self.nav_est.v_eci, q, y[SL_M_OMEGA],
            float(y[SL_M_MASS.start]))
        aero = {"q_dyn": self._last_q_dyn, "CN_ALPHA": self._last_cn_alpha}
        is_ok, ho_info = self.handover.check(
            t, m_state_obj, target_state, self.seeker_meas, aero)
        self.handover_info = dict(ho_info)
        if is_ok and self.handover_trigger is None:
            self.handover_trigger = dict(ho_info)
            self.handover_trigger["t"] = float(t)
        a_cmd, triggered, _ = self.handover.update(
            t, is_ok, a_mid.a_cmd_eci, a_term.a_cmd_eci)

        if triggered:
            self.phase = "terminal"
            self.handover_flag = 1.0
        self.guidance_cmd = C.GuidanceCommand(
            a_cmd_eci=np.asarray(a_cmd, dtype=float), phase=self.phase)

    # --------------------------------------------------------
    def _log(self, t, y):
        """Write one telemetry frame using the latest continuous info cache."""
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
        lead_angle = MU.angle_between(v, u) if MU.norm3(v) > 1.0 else np.pi
        dh = MU.altitude(r) - MU.altitude(r_t)
        nav_err = MU.norm3(self.nav_est.r_eci - r)
        tgt_est_err = MU.norm3(self.tracker.position() - r_t)

        Fb = info.get("F_body", np.zeros(3))
        m = max(mass, 1e-6)
        # Body -> ECI by the current attitude quaternion (no DCM round-trip).
        a_act = MU.quat_rotate(q, Fb) / m
        load = Fb / (m * C.G0)

        a_cmd = self.guidance_cmd.a_cmd_eci
        fins = self.act_cmd.delta_fins
        seeker = self.seeker_meas
        fov_angle = float(seeker.fov_angle) if seeker is not None else 0.0
        locked = 1.0 if (seeker is not None and seeker.is_locked) else 0.0

        # ---- Extended observables -------------------------------------
        # Atmosphere at the missile altitude.
        atm = get_atmosphere(alt)

        # ECI -> ECEF (Earth rotation) for position and velocity.
        theta = C.OMEGA_EARTH * t
        ct, st = math.cos(theta), math.sin(theta)
        we = C.OMEGA_EARTH
        v_eci_rot = np.array([v[0] + we * r[1], v[1] - we * r[0], v[2]])
        m_ecef = np.array([ct * r[0] + st * r[1],
                           -st * r[0] + ct * r[1],
                           r[2]])
        m_vecef = np.array([ct * v_eci_rot[0] + st * v_eci_rot[1],
                            -st * v_eci_rot[0] + ct * v_eci_rot[1],
                            v_eci_rot[2]])

        # Local NED frame at the missile position (ENU columns -> ECI).
        enu = MU.local_enu_dcm(lat, lon, t)
        ned_dcm = np.vstack((enu[:, 1], enu[:, 0], -enu[:, 2]))
        m_vned = ned_dcm.dot(v)

        # Body -> local NED attitude, then ZYX Euler angles.
        c_bn = ned_dcm.dot(MU.quat_to_dcm(q))
        yaw = math.atan2(c_bn[1, 0], c_bn[0, 0])
        pitch = math.asin(float(np.clip(-c_bn[2, 0], -1.0, 1.0)))
        roll = math.atan2(c_bn[2, 1], c_bn[2, 2])

        speed = MU.norm3(v)
        v_air = MU.atmosphere_relative_velocity(r, v)
        airspeed = MU.norm3(v_air)
        gamma = math.asin(float(np.clip(-m_vned[2] / max(speed, 1e-6),
                                        -1.0, 1.0)))
        chi = math.atan2(m_vned[1], m_vned[0])

        a_cmd_b = MU.quat_rotate_inv(q, a_cmd)
        n_cmd_g = MU.norm3(a_cmd) / C.G0

        # LOS geometry and seeker measurements.
        geo = MU.los_geometry(r, v, r_t, v_t)
        los = geo["u"]
        los_rate = geo["omega"]
        vc = max(-float(geo["range_rate"]), 50.0)
        t_go = max(float(geo["range"]) / vc, 0.05)

        nav_r = np.asarray(self.nav_est.r_eci, dtype=float)
        nav_v = np.asarray(self.nav_est.v_eci, dtype=float)
        nav_err_vec = nav_r - r
        rel = r_t - r
        t_lat, t_lon, t_alt = MU.eci_to_llh(r_t, t)
        dy_t = self.target.derivatives(
            t, np.concatenate((r_t, v_t)), r)
        t_acc = np.asarray(dy_t[3:6], dtype=float)
        seeker_range = float(seeker.range) if seeker is not None else 0.0
        seeker_range_rate = (float(seeker.range_rate)
                             if seeker is not None else 0.0)
        if seeker is not None:
            seeker_los = np.asarray(seeker.los_angle, dtype=float)
            seeker_los_rate = np.asarray(seeker.los_rate, dtype=float)
        else:
            seeker_los = np.zeros(3)
            seeker_los_rate = np.zeros(3)

        # Body axes in ECI (columns of the body-to-ECI DCM).
        dcm_be = MU.quat_to_dcm(q)
        bx_axis, by_axis, bz_axis = dcm_be[:, 0], dcm_be[:, 1], dcm_be[:, 2]
        mb = np.asarray(info.get("M_body", np.zeros(3)), dtype=float)

        # Target ECEF position and velocity.
        v_t_rot = np.array([v_t[0] + we * r_t[1],
                            v_t[1] - we * r_t[0],
                            v_t[2]])
        t_ecef = np.array([ct * r_t[0] + st * r_t[1],
                           -st * r_t[0] + ct * r_t[1],
                           r_t[2]])
        t_vecef = np.array([ct * v_t_rot[0] + st * v_t_rot[1],
                            -st * v_t_rot[0] + ct * v_t_rot[1],
                            v_t_rot[2]])
        grav = MU.gravity_eci(r)

        values = [
            r[0], r[1], r[2], v[0], v[1], v[2],
            r_t[0], r_t[1], r_t[2], v_t[0], v_t[1], v_t[2],
            mass, info["mach"], info["q_dyn"], alt, lat, lon,
            info["alpha"], info["beta"], load[0], load[1], load[2],
            a_cmd[0], a_cmd[1], a_cmd[2],
            a_act[0], a_act[1], a_act[2],
            fins[0], fins[1], fins[2], fins[3],
            1.0 if self.act_cmd.is_saturated else 0.0,
            nav_err, R, range_rate, locked, fov_angle,
            PHASE_CODE.get(self.phase, 1.0), self.handover_flag, dh, lead_angle,
            omega[0], omega[1], omega[2],
            tgt_est_err,
            # ---- Extended observables (order matches TELEMETRY_COLUMNS) ----
            m_ecef[0], m_ecef[1], m_ecef[2],
            m_vecef[0], m_vecef[1], m_vecef[2],
            m_vned[0], m_vned[1], m_vned[2],
            q[0], q[1], q[2], q[3],
            math.degrees(roll), math.degrees(pitch), math.degrees(yaw),
            math.degrees(gamma), math.degrees(chi),
            speed, airspeed,
            atm.density, atm.sound_speed,
            Fb[0], Fb[1], Fb[2],
            a_cmd_b[0], a_cmd_b[1], a_cmd_b[2], n_cmd_g,
            los[0], los[1], los[2],
            los_rate[0], los_rate[1], los_rate[2],
            t_go, vc,
            nav_r[0], nav_r[1], nav_r[2],
            nav_v[0], nav_v[1], nav_v[2],
            nav_err_vec[0], nav_err_vec[1], nav_err_vec[2],
            rel[0], rel[1], rel[2],
            t_lat, t_lon, t_alt,
            t_acc[0], t_acc[1], t_acc[2],
            seeker_range, seeker_range_rate,
            bx_axis[0], bx_axis[1], bx_axis[2],
            by_axis[0], by_axis[1], by_axis[2],
            bz_axis[0], bz_axis[1], bz_axis[2],
            mb[0], mb[1], mb[2],
            t_ecef[0], t_ecef[1], t_ecef[2],
            t_vecef[0], t_vecef[1], t_vecef[2],
            seeker_los[0], seeker_los[1], seeker_los[2],
            seeker_los_rate[0], seeker_los_rate[1], seeker_los_rate[2],
            grav[0], grav[1], grav[2],
        ]
        # The full value list is always built; the selected profile decides how
        # many trailing columns reach the CSV/buffer.
        self.telemetry.send(t, values[:self.telemetry.n_cols - 1])

    # --------------------------------------------------------
    def _step_size(self, t, y):
        """Phase-dependent outer step: midcourse cruise is quasi-steady."""
        if self.phase == "midcourse":
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
            max_steps=self.cfg.max_integration_steps)
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

        # Fallback if no event fired: minimum logged range.
        if np.isnan(self.miss_distance) and self.telemetry.n > 0:
            rng = self.telemetry.get("range")
            idx = int(np.argmin(rng))
            self.miss_distance = float(rng[idx])
            self.miss_time = float(self.telemetry.get("time")[idx])

        if self.cfg.verbose:
            print("=" * 64)
            print("Simulation: %s" % ("success" if sol.success else "failed: " + sol.message))
            print("Integrator: native RK4 | step: %.4f s (midcourse %.4f s) | RHS calls: %d"
                  % (self.cfg.max_step, self.cfg.midcourse_max_step, sol.nfev))
            print("CPU time: %.2f s" % self.cpu_time)
            print("Miss distance: %.2f m @ t=%.3f s" % (self.miss_distance, self.miss_time))
            print("Telemetry frames: %d" % self.telemetry.n)
            print("=" * 64)
        return sol

    # --------------------------------------------------------
    def save(self, out_dir=None):
        out_dir = out_dir or self.cfg.output_dir
        if not os.path.isdir(out_dir):
            os.makedirs(out_dir)
        path = self.telemetry.save_csv(os.path.join(out_dir, "telemetry.csv"))
        print("Telemetry saved: %s" % os.path.abspath(path))
        return path


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
        del sim   # release the telemetry buffer before the next level

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
    parser.add_argument("--duration", type=float, default=None, help="simulation stop time s")
    parser.add_argument("--no-plot", action="store_true", help="skip plotting")
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
    if args.max_step is not None:
        cfg.max_step = args.max_step
    if args.midcourse_step is not None:
        cfg.midcourse_max_step = args.midcourse_step
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
    sim.save()
    if cfg.enable_plot:
        plot_results(sim)
    return sim


if __name__ == "__main__":
    main()
