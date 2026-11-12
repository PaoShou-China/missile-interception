"""3D math utilities: vectors, quaternions, frame transforms, LLH <-> ECI.

Pure functions with no state and no dependency other than numpy + config.
Primary frame: ECI.  Earth is a sphere of radius Re = 6371 km.

Ref: WGS84 geodetic-to-ECEF; spherical ECI approximation.
"""

import math
import numpy as np
import config as C

_EPS = 1e-12


# ------------------------------------------------------------
# Basic vector operations (always 3D)
# ------------------------------------------------------------
def as_vec3(x):
    """Return a flat (3,) float array and validate the dimension."""
    if type(x) is np.ndarray and x.shape == (3,) and x.dtype == np.float64:
        return x
    v = np.asarray(x, dtype=float)
    if v.shape != (3,):
        v = v.reshape(-1)
        if v.size != 3:
            raise ValueError("Expected a 3-vector, got %d elements" % v.size)
    return v


def norm3(v):
    """Euclidean norm of a 3-vector."""
    v = as_vec3(v)
    return float(math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]))


def normalize(v, fallback=None):
    """Normalize; a zero vector returns ``fallback`` (default [1,0,0])."""
    v = as_vec3(v)
    n = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
    if n < _EPS:
        if fallback is None:
            fallback = np.array([1.0, 0.0, 0.0])
        return as_vec3(fallback).copy()
    return v / n


def dot3(a, b):
    a = as_vec3(a)
    b = as_vec3(b)
    return float(a[0] * b[0] + a[1] * b[1] + a[2] * b[2])


def cross3(a, b):
    a = as_vec3(a)
    b = as_vec3(b)
    return np.array([
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ])


def perpendicular(v, u):
    """Projection of v on the plane normal to u: v - (v.u)u."""
    u = normalize(u)
    v = as_vec3(v)
    return v - dot3(v, u) * u


def angle_between(a, b):
    """Angle between two vectors in radians (clipped for numerical safety)."""
    a = normalize(a)
    b = normalize(b)
    c = dot3(a, b)
    if c > 1.0:
        c = 1.0
    elif c < -1.0:
        c = -1.0
    return float(math.acos(c))


def clip_norm(v, limit):
    """Clip a vector to a maximum magnitude."""
    v = as_vec3(v)
    n = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
    if n > limit and n > _EPS:
        return v * (limit / n)
    return v


# ------------------------------------------------------------
# Quaternions (scalar first: q = [w, x, y, z], body -> ECI)
# ------------------------------------------------------------
def quat_normalize(q):
    q = np.asarray(q, dtype=float).reshape(4)
    n = math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3])
    if n < _EPS:
        return np.array([1.0, 0.0, 0.0, 0.0])
    return q / n


def quat_to_dcm(q):
    """Quaternion to direction cosine matrix (body -> ECI)."""
    w, x, y, z = quat_normalize(q)
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ])


def dcm_to_quat(dcm):
    """Direction cosine matrix to quaternion (Shepperd's robust method)."""
    m = np.asarray(dcm, dtype=float)
    tr = m[0, 0] + m[1, 1] + m[2, 2]
    if tr > 0.0:
        s = math.sqrt(tr + 1.0) * 2.0
        w = 0.25 * s
        x = (m[2, 1] - m[1, 2]) / s
        y = (m[0, 2] - m[2, 0]) / s
        z = (m[1, 0] - m[0, 1]) / s
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2.0
        w = (m[2, 1] - m[1, 2]) / s
        x = 0.25 * s
        y = (m[0, 1] + m[1, 0]) / s
        z = (m[0, 2] + m[2, 0]) / s
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2.0
        w = (m[0, 2] - m[2, 0]) / s
        x = (m[0, 1] + m[1, 0]) / s
        y = 0.25 * s
        z = (m[1, 2] + m[2, 1]) / s
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2.0
        w = (m[1, 0] - m[0, 1]) / s
        x = (m[0, 2] + m[2, 0]) / s
        y = (m[1, 2] + m[2, 1]) / s
        z = 0.25 * s
    return quat_normalize(np.array([w, x, y, z]))


def quat_derivative(q, omega_body):
    """Quaternion kinematics qdot = 0.5 * q (x) [0, omega] (expanded)."""
    w, x, y, z = np.asarray(q, dtype=float).reshape(4)
    p, qq, r = np.asarray(omega_body, dtype=float).reshape(3)
    return 0.5 * np.array([
        -x * p - y * qq - z * r,
        w * p + y * r - z * qq,
        w * qq - x * r + z * p,
        w * r + x * qq - y * p,
    ])


def quat_mul(a, b):
    """Hamilton product ``a (x) b`` (scalar first)."""
    aw, ax, ay, az = np.asarray(a, dtype=float).reshape(4)
    bw, bx, by, bz = np.asarray(b, dtype=float).reshape(4)
    return np.array([
        aw * bw - ax * bx - ay * by - az * bz,
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
    ])


def quat_exp(omega_body, dt):
    """Quaternion increment of a constant body rate over ``dt``.

    For a body rate ``w`` the attitude update is ``q (x) exp(0.5 w dt)``;
    this returns the unit quaternion ``exp(0.5 w dt)``.
    """
    w = as_vec3(omega_body) * float(dt)
    angle = math.sqrt(w[0] * w[0] + w[1] * w[1] + w[2] * w[2])
    if angle < 1e-12:
        return np.array([1.0, 0.0, 0.0, 0.0])
    axis = w / angle
    s = math.sin(0.5 * angle)
    return np.array([math.cos(0.5 * angle),
                     axis[0] * s, axis[1] * s, axis[2] * s])


def quat_propagate(q, omega_body, dt):
    """Advance a body->ECI attitude by a constant body rate."""
    return quat_normalize(quat_mul(q, quat_exp(omega_body, dt)))



def quat_conj(q):
    """Conjugate (inverse for a unit quaternion)."""
    q = np.asarray(q, dtype=float).reshape(4)
    return np.array([q[0], -q[1], -q[2], -q[3]])


def quat_rotate(q, v):
    """Rotate a body-frame vector into ECI with ``q`` (body -> ECI)."""
    w, x, y, z = quat_normalize(q)
    v = as_vec3(v)
    # t = 2 * (q_vec x v); v' = v + w * t + q_vec x t
    tx = 2.0 * (y * v[2] - z * v[1])
    ty = 2.0 * (z * v[0] - x * v[2])
    tz = 2.0 * (x * v[1] - y * v[0])
    return np.array([
        v[0] + w * tx + (y * tz - z * ty),
        v[1] + w * ty + (z * tx - x * tz),
        v[2] + w * tz + (x * ty - y * tx),
    ])


def quat_rotate_inv(q, v):
    """Rotate an ECI vector into the body frame (conjugate rotation)."""
    return quat_rotate(quat_conj(q), v)


def quat_hemisphere(q, ref):
    """Return the representation of ``q`` in the same hemisphere as ``ref``.

    q and -q are the same attitude; keeping a consistent sign avoids a
    discontinuous state vector (which would break dense output and event
    interpolation between two steps).
    """
    q = quat_normalize(q)
    ref = np.asarray(ref, dtype=float).reshape(4)
    dot = q[0] * ref[0] + q[1] * ref[1] + q[2] * ref[2] + q[3] * ref[3]
    return -q if dot < 0.0 else q


def quat_align_body_x(direction, up_hint=None):
    """Attitude with +x_B along ``direction`` and +z_B closest to ``up_hint``.

    Same construction as ``uniflight.control.quaternion_align_body_x``: the
    hint is projected onto the plane normal to +x_B, an orthonormal frame is
    formed by two cross products, and the matrix is converted with Shepperd's
    method.  No Euler angle is ever formed, so a vertical or 180-deg case is
    handled without a singularity.
    """
    x = normalize(direction)
    hint = np.array([0.0, 0.0, 1.0]) if up_hint is None else as_vec3(up_hint)
    z = hint - dot3(hint, x) * x
    if norm3(z) < 1e-9:
        alt = np.array([0.0, 1.0, 0.0])
        z = alt - dot3(alt, x) * x
    z = normalize(z)
    y = normalize(cross3(z, x))
    z = cross3(x, y)
    return dcm_to_quat(np.column_stack((x, y, z)))


def quat_from_body_x(x_dir, up_ref):
    """Build an attitude quaternion from the body X direction and an up ref.

    Body axes: X forward, Y right, Z down (Z = -up).  Expressed through the
    uniflight alignment primitive with the up hint negated (body Z points
    down), so the launch frame and the tests share one canonical construction.
    """
    return quat_align_body_x(x_dir, -as_vec3(up_ref))


# ------------------------------------------------------------
# Earth / LLH <-> ECI (WGS84 geodetic or spherical fallback)
# ------------------------------------------------------------
def _geodetic_altitude(r):
    """Geodetic altitude from an ECI position (Bowring closed form).

    Falls back to ``|r| - RE`` when ``config.EARTH_MODEL`` is the sphere, so
    the legacy model is reproduced bit-for-bit.
    """
    r = as_vec3(r)
    if C.EARTH_MODEL_CODE == 0:
        return float(math.sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]) - C.RE)
    p = math.sqrt(r[0] * r[0] + r[1] * r[1])
    a, b, e2 = C.WGS84_A, C.WGS84_B, C.WGS84_E2
    if p < 1e-9:
        return float(abs(r[2]) - b)
    ep2 = (a * a - b * b) / (b * b)
    th = math.atan2(r[2] * a, p * b)
    st = math.sin(th)
    ct = math.cos(th)
    phi = math.atan2(r[2] + ep2 * b * st * st * st,
                     p - e2 * a * ct * ct * ct)
    n = a / math.sqrt(1.0 - e2 * math.sin(phi) ** 2)
    return float(p / math.cos(phi) - n)


def llh_to_eci(lat_deg, lon_deg, alt_m, t=0.0):
    """Geodetic LLH to ECI; ECI and ECEF coincide at t=0."""
    lat = lat_deg * C.DEG
    lon = lon_deg * C.DEG + C.OMEGA_EARTH * t
    if C.EARTH_MODEL_CODE == 0:
        r = C.RE + alt_m
        return np.array([
            r * math.cos(lat) * math.cos(lon),
            r * math.cos(lat) * math.sin(lon),
            r * math.sin(lat),
        ])
    s = math.sin(lat)
    n = C.WGS84_A / math.sqrt(1.0 - C.WGS84_E2 * s * s)
    rr = (n + alt_m) * math.cos(lat)
    return np.array([
        rr * math.cos(lon),
        rr * math.sin(lon),
        (n * (1.0 - C.WGS84_E2) + alt_m) * s,
    ])


def eci_to_llh(r_eci, t=0.0):
    """ECI position to geodetic ``(lat_deg, lon_deg, alt_m)``."""
    r = as_vec3(r_eci)
    lon = math.atan2(r[1], r[0]) - C.OMEGA_EARTH * t
    lon = (lon + math.pi) % (2.0 * math.pi) - math.pi
    if C.EARTH_MODEL_CODE == 0:
        rad = math.sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2])
        lat = math.asin(float(np.clip(r[2] / max(rad, _EPS), -1.0, 1.0)))
        return float(lat / C.DEG), float(lon / C.DEG), float(rad - C.RE)
    p = math.sqrt(r[0] * r[0] + r[1] * r[1])
    a, b, e2 = C.WGS84_A, C.WGS84_B, C.WGS84_E2
    if p < 1e-9:
        lat = math.copysign(0.5 * math.pi, r[2])
        return float(lat / C.DEG), float(lon / C.DEG), float(abs(r[2]) - b)
    ep2 = (a * a - b * b) / (b * b)
    th = math.atan2(r[2] * a, p * b)
    st = math.sin(th)
    ct = math.cos(th)
    lat = math.atan2(r[2] + ep2 * b * st * st * st,
                     p - e2 * a * ct * ct * ct)
    n = a / math.sqrt(1.0 - e2 * math.sin(lat) ** 2)
    alt = p / math.cos(lat) - n
    return float(lat / C.DEG), float(lon / C.DEG), float(alt)


def altitude(r_eci):
    """Geodetic altitude in metres (spherical in sphere mode)."""
    return _geodetic_altitude(r_eci)


def local_up(r_eci):
    """Unit local vertical in ECI.

    In WGS84 mode this is the ellipsoid (geodetic) normal, not the radial
    direction: at 28-40 deg latitude the two differ by ~0.19 deg, which is
    enough to make a "level" trajectory drift a kilometre in geodetic
    altitude over a long midcourse.  Everything that defines the local
    horizontal, a climb angle or an altitude offset must use this vector so
    that it agrees with ``altitude()`` and with the LLH<->ECI conversion.
    Sphere mode returns the radial direction, i.e. the old behaviour.
    """
    r = as_vec3(r_eci)
    if C.EARTH_MODEL_CODE == 0:
        return normalize(r)
    p = math.hypot(r[0], r[1])
    if p < 1e-9:
        lat = math.copysign(0.5 * math.pi, r[2])
    else:
        a, b, e2 = C.WGS84_A, C.WGS84_B, C.WGS84_E2
        ep2 = (a * a - b * b) / (b * b)
        th = math.atan2(r[2] * a, p * b)
        st = math.sin(th)
        ct = math.cos(th)
        lat = math.atan2(r[2] + ep2 * b * st * st * st,
                         p - e2 * a * ct * ct * ct)
    lon = math.atan2(r[1], r[0])
    cl = math.cos(lat)
    return np.array([cl * math.cos(lon), cl * math.sin(lon), math.sin(lat)])



def local_enu_dcm(lat_deg, lon_deg, t=0.0):
    """Local ENU -> ECI rotation (columns are E, N, U in ECI)."""
    lat = lat_deg * C.DEG
    lon = lon_deg * C.DEG + C.OMEGA_EARTH * t
    e = np.array([-math.sin(lon), math.cos(lon), 0.0])
    n = np.array([-math.sin(lat) * math.cos(lon),
                  -math.sin(lat) * math.sin(lon),
                  math.cos(lat)])
    u = np.array([math.cos(lat) * math.cos(lon),
                  math.cos(lat) * math.sin(lon),
                  math.sin(lat)])
    return np.column_stack((e, n, u))


def gravity_eci(r_eci):
    """Gravity acceleration in ECI, m/s^2 (central field + optional J2)."""
    r = as_vec3(r_eci)
    r2 = r[0] * r[0] + r[1] * r[1] + r[2] * r[2]
    rad = max(math.sqrt(r2), _EPS)
    r3 = rad * rad * rad
    a = -C.MU * r / r3
    if C.EARTH_MODEL_CODE == 0:
        return a
    z2 = r[2] * r[2]
    r5 = r3 * r2
    k = -1.5 * C.J2 * C.MU * C.WGS84_A * C.WGS84_A / r5
    zf = 5.0 * z2 / r2
    a[0] += k * r[0] * (1.0 - zf)
    a[1] += k * r[1] * (1.0 - zf)
    a[2] += k * r[2] * (3.0 - zf)
    return a


def atmosphere_relative_velocity(r_eci, v_eci):
    """Air-relative velocity (subtract the Earth-rotation transport term)."""
    w = C.OMEGA_EARTH
    r = as_vec3(r_eci)
    v = as_vec3(v_eci)
    return np.array([v[0] + w * r[1], v[1] - w * r[0], v[2]])


# ------------------------------------------------------------
# Line-of-sight geometry
# ------------------------------------------------------------
def los_vector(r_m, r_t):
    """Missile-to-target LOS vector."""
    return as_vec3(r_t) - as_vec3(r_m)


def los_geometry(r_m, v_m, r_t, v_t):
    """3D LOS geometry: range, LOS unit vector, relative velocity and rate."""
    rho = los_vector(r_m, r_t)
    R = math.sqrt(rho[0] * rho[0] + rho[1] * rho[1] + rho[2] * rho[2])
    if R < _EPS:
        R = _EPS
    u = rho / R
    v_rel = as_vec3(v_t) - as_vec3(v_m)
    range_rate = float(u[0] * v_rel[0] + u[1] * v_rel[1] + u[2] * v_rel[2])
    omega = np.array([
        (rho[1] * v_rel[2] - rho[2] * v_rel[1]) / (R * R),
        (rho[2] * v_rel[0] - rho[0] * v_rel[2]) / (R * R),
        (rho[0] * v_rel[1] - rho[1] * v_rel[0]) / (R * R),
    ])
    return {
        "rho": rho,
        "range": R,
        "u": u,
        "v_rel": v_rel,
        "range_rate": range_rate,
        "omega": omega,
    }


def predict_intercept(r_m, v_m, r_t, v_t, max_iter=8):
    """Iterative predicted intercept point and time-to-go."""
    r_m = as_vec3(r_m)
    v_m = as_vec3(v_m)
    r_t = as_vec3(r_t)
    v_t = as_vec3(v_t)
    speed = max(norm3(v_m), 1.0)
    t_go = max(norm3(r_t - r_m) / speed, 1.0)
    for _ in range(max_iter):
        r_p = r_t + v_t * t_go
        t_new = max(norm3(r_p - r_m) / speed, 1.0)
        if abs(t_new - t_go) < 0.5:
            t_go = t_new
            break
        t_go = 0.5 * (t_go + t_new)
    return r_t + v_t * t_go, t_go
