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
    if type(v) is np.ndarray and v.shape == (3,):
        return math.sqrt(float(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]))
    v = as_vec3(v)
    return float(math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]))


def normalize(v, fallback=None):
    """Normalize; a zero vector returns ``fallback`` (default [1,0,0])."""
    if not (type(v) is np.ndarray and v.shape == (3,) and v.dtype == np.float64):
        v = as_vec3(v)
    n = math.sqrt(float(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]))
    if n < _EPS:
        if fallback is None:
            return np.array([1.0, 0.0, 0.0])
        return as_vec3(fallback).copy()
    inv = 1.0 / n
    return np.array([v[0] * inv, v[1] * inv, v[2] * inv])


def dot3(a, b):
    if not (type(a) is np.ndarray and a.shape == (3,)):
        a = as_vec3(a)
    if not (type(b) is np.ndarray and b.shape == (3,)):
        b = as_vec3(b)
    return float(a[0] * b[0] + a[1] * b[1] + a[2] * b[2])


def cross3(a, b):
    if not (type(a) is np.ndarray and a.shape == (3,)):
        a = as_vec3(a)
    if not (type(b) is np.ndarray and b.shape == (3,)):
        b = as_vec3(b)
    return np.array([
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ])


def perpendicular(v, u):
    """Projection of v on the plane normal to u: v - (v.u)u."""
    if not (type(v) is np.ndarray and v.shape == (3,)):
        v = as_vec3(v)
    if not (type(u) is np.ndarray and u.shape == (3,)):
        u = as_vec3(u)
    un = math.sqrt(float(u[0] * u[0] + u[1] * u[1] + u[2] * u[2]))
    if un < _EPS:
        ux, uy, uz = 1.0, 0.0, 0.0
    else:
        inv = 1.0 / un
        ux, uy, uz = float(u[0]) * inv, float(u[1]) * inv, float(u[2]) * inv
    d = float(v[0]) * ux + float(v[1]) * uy + float(v[2]) * uz
    return np.array([float(v[0]) - d * ux, float(v[1]) - d * uy, float(v[2]) - d * uz])


def angle_between(a, b):
    """Angle between two vectors in radians (clipped for numerical safety)."""
    if not (type(a) is np.ndarray and a.shape == (3,)):
        a = as_vec3(a)
    if not (type(b) is np.ndarray and b.shape == (3,)):
        b = as_vec3(b)
    na = math.sqrt(float(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]))
    nb = math.sqrt(float(b[0] * b[0] + b[1] * b[1] + b[2] * b[2]))
    ax, ay, az = (1.0, 0.0, 0.0) if na < _EPS else (float(a[0]) / na, float(a[1]) / na, float(a[2]) / na)
    bx, by, bz = (1.0, 0.0, 0.0) if nb < _EPS else (float(b[0]) / nb, float(b[1]) / nb, float(b[2]) / nb)
    c = ax * bx + ay * by + az * bz
    if c > 1.0:
        c = 1.0
    elif c < -1.0:
        c = -1.0
    return math.acos(c)


def clip_norm(v, limit):
    """Clip a vector to a maximum magnitude."""
    if not (type(v) is np.ndarray and v.shape == (3,) and v.dtype == np.float64):
        v = as_vec3(v)
    n = math.sqrt(float(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]))
    if n > limit and n > _EPS:
        s = limit / n
        return np.array([v[0] * s, v[1] * s, v[2] * s])
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
    if not (type(r) is np.ndarray and r.shape == (3,)):
        r = as_vec3(r)
    rx, ry, rz = float(r[0]), float(r[1]), float(r[2])
    if C.EARTH_MODEL_CODE == 0:
        return math.sqrt(rx * rx + ry * ry + rz * rz) - C.RE
    p = math.sqrt(rx * rx + ry * ry)
    a, b, e2 = C.WGS84_A, C.WGS84_B, C.WGS84_E2
    if p < 1e-9:
        return abs(rz) - b
    ep2 = (a * a - b * b) / (b * b)
    th = math.atan2(rz * a, p * b)
    st = math.sin(th)
    ct = math.cos(th)
    phi = math.atan2(rz + ep2 * b * st * st * st,
                     p - e2 * a * ct * ct * ct)
    sp = math.sin(phi)
    n = a / math.sqrt(1.0 - e2 * sp * sp)
    return p / math.cos(phi) - n


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
    if not (type(r_eci) is np.ndarray and r_eci.shape == (3,)):
        r_eci = as_vec3(r_eci)
    rx, ry, rz = float(r_eci[0]), float(r_eci[1]), float(r_eci[2])
    lon = math.atan2(ry, rx) - C.OMEGA_EARTH * t
    lon = (lon + math.pi) % (2.0 * math.pi) - math.pi
    if C.EARTH_MODEL_CODE == 0:
        rad = math.sqrt(rx * rx + ry * ry + rz * rz)
        s = rz / (rad if rad > _EPS else _EPS)
        if s > 1.0:
            s = 1.0
        elif s < -1.0:
            s = -1.0
        lat = math.asin(s)
        return lat / C.DEG, lon / C.DEG, rad - C.RE
    p = math.sqrt(rx * rx + ry * ry)
    a, b, e2 = C.WGS84_A, C.WGS84_B, C.WGS84_E2
    if p < 1e-9:
        lat = math.copysign(0.5 * math.pi, rz)
        return lat / C.DEG, lon / C.DEG, abs(rz) - b
    ep2 = (a * a - b * b) / (b * b)
    th = math.atan2(rz * a, p * b)
    st = math.sin(th)
    ct = math.cos(th)
    lat = math.atan2(rz + ep2 * b * st * st * st,
                     p - e2 * a * ct * ct * ct)
    sl = math.sin(lat)
    n = a / math.sqrt(1.0 - e2 * sl * sl)
    alt = p / math.cos(lat) - n
    return lat / C.DEG, lon / C.DEG, alt


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
    if not (type(r_eci) is np.ndarray and r_eci.shape == (3,)):
        r_eci = as_vec3(r_eci)
    if C.EARTH_MODEL_CODE == 0:
        return normalize(r_eci)
    rx, ry, rz = float(r_eci[0]), float(r_eci[1]), float(r_eci[2])
    p = math.hypot(rx, ry)
    if p < 1e-9:
        lat = math.copysign(0.5 * math.pi, rz)
    else:
        a, b, e2 = C.WGS84_A, C.WGS84_B, C.WGS84_E2
        ep2 = (a * a - b * b) / (b * b)
        th = math.atan2(rz * a, p * b)
        st = math.sin(th)
        ct = math.cos(th)
        lat = math.atan2(rz + ep2 * b * st * st * st,
                         p - e2 * a * ct * ct * ct)
    lon = math.atan2(ry, rx)
    cl = math.cos(lat)
    return np.array([cl * math.cos(lon), cl * math.sin(lon), math.sin(lat)])



def local_enu_dcm(lat_deg, lon_deg, t=0.0):
    """Local ENU -> ECI rotation (columns are E, N, U in ECI)."""
    lat = lat_deg * C.DEG
    lon = lon_deg * C.DEG + C.OMEGA_EARTH * t
    sl, cl = math.sin(lat), math.cos(lat)
    so, co = math.sin(lon), math.cos(lon)
    return np.array([
        [-so, -sl * co, cl * co],
        [co,  -sl * so, cl * so],
        [0.0, cl,       sl],
    ])


def gravity_eci(r_eci):
    """Gravity acceleration in ECI, m/s^2 (central field + optional J2)."""
    if not (type(r_eci) is np.ndarray and r_eci.shape == (3,)):
        r_eci = as_vec3(r_eci)
    rx, ry, rz = float(r_eci[0]), float(r_eci[1]), float(r_eci[2])
    r2 = rx * rx + ry * ry + rz * rz
    rad = math.sqrt(r2)
    if rad < _EPS:
        rad = _EPS
    r3 = rad * rad * rad
    c0 = -C.MU / r3
    ax, ay, az = c0 * rx, c0 * ry, c0 * rz
    if C.EARTH_MODEL_CODE == 0:
        return np.array([ax, ay, az])
    z2 = rz * rz
    r5 = r3 * r2
    k = -1.5 * C.J2 * C.MU * C.WGS84_A * C.WGS84_A / r5
    zf = 5.0 * z2 / r2
    ax += k * rx * (1.0 - zf)
    ay += k * ry * (1.0 - zf)
    az += k * rz * (3.0 - zf)
    return np.array([ax, ay, az])


def atmosphere_relative_velocity(r_eci, v_eci):
    """Air-relative velocity (subtract the Earth-rotation transport term)."""
    w = C.OMEGA_EARTH
    if not (type(r_eci) is np.ndarray and r_eci.shape == (3,)):
        r_eci = as_vec3(r_eci)
    if not (type(v_eci) is np.ndarray and v_eci.shape == (3,)):
        v_eci = as_vec3(v_eci)
    return np.array([float(v_eci[0]) + w * float(r_eci[1]),
                     float(v_eci[1]) - w * float(r_eci[0]),
                     float(v_eci[2])])


# ------------------------------------------------------------
# Line-of-sight geometry
# ------------------------------------------------------------
def los_vector(r_m, r_t):
    """Missile-to-target LOS vector."""
    if not (type(r_m) is np.ndarray and r_m.shape == (3,)):
        r_m = as_vec3(r_m)
    if not (type(r_t) is np.ndarray and r_t.shape == (3,)):
        r_t = as_vec3(r_t)
    return np.array([float(r_t[0] - r_m[0]),
                     float(r_t[1] - r_m[1]),
                     float(r_t[2] - r_m[2])])


def los_geometry(r_m, v_m, r_t, v_t):
    """3D LOS geometry: range, LOS unit vector, relative velocity and rate."""
    if not (type(r_m) is np.ndarray and r_m.shape == (3,)):
        r_m = as_vec3(r_m)
    if not (type(v_m) is np.ndarray and v_m.shape == (3,)):
        v_m = as_vec3(v_m)
    if not (type(r_t) is np.ndarray and r_t.shape == (3,)):
        r_t = as_vec3(r_t)
    if not (type(v_t) is np.ndarray and v_t.shape == (3,)):
        v_t = as_vec3(v_t)
    dx = float(r_t[0] - r_m[0])
    dy = float(r_t[1] - r_m[1])
    dz = float(r_t[2] - r_m[2])
    R = math.sqrt(dx * dx + dy * dy + dz * dz)
    if R < _EPS:
        R = _EPS
    inv_r = 1.0 / R
    ux, uy, uz = dx * inv_r, dy * inv_r, dz * inv_r
    vrx = float(v_t[0] - v_m[0])
    vry = float(v_t[1] - v_m[1])
    vrz = float(v_t[2] - v_m[2])
    range_rate = ux * vrx + uy * vry + uz * vrz
    inv_r2 = inv_r * inv_r
    return {
        "rho": np.array([dx, dy, dz]),
        "range": R,
        "u": np.array([ux, uy, uz]),
        "v_rel": np.array([vrx, vry, vrz]),
        "range_rate": range_rate,
        "omega": np.array([
            (dy * vrz - dz * vry) * inv_r2,
            (dz * vrx - dx * vrz) * inv_r2,
            (dx * vry - dy * vrx) * inv_r2,
        ]),
    }


def predict_intercept(r_m, v_m, r_t, v_t, max_iter=8):
    """Iterative predicted intercept point and time-to-go."""
    if not (type(r_m) is np.ndarray and r_m.shape == (3,)):
        r_m = as_vec3(r_m)
    if not (type(v_m) is np.ndarray and v_m.shape == (3,)):
        v_m = as_vec3(v_m)
    if not (type(r_t) is np.ndarray and r_t.shape == (3,)):
        r_t = as_vec3(r_t)
    if not (type(v_t) is np.ndarray and v_t.shape == (3,)):
        v_t = as_vec3(v_t)
    rmx, rmy, rmz = float(r_m[0]), float(r_m[1]), float(r_m[2])
    vmx, vmy, vmz = float(v_m[0]), float(v_m[1]), float(v_m[2])
    rtx, rty, rtz = float(r_t[0]), float(r_t[1]), float(r_t[2])
    vtx, vty, vtz = float(v_t[0]), float(v_t[1]), float(v_t[2])
    speed = math.sqrt(vmx * vmx + vmy * vmy + vmz * vmz)
    if speed < 1.0:
        speed = 1.0
    inv_spd = 1.0 / speed
    dx0, dy0, dz0 = rtx - rmx, rty - rmy, rtz - rmz
    t_go = math.sqrt(dx0 * dx0 + dy0 * dy0 + dz0 * dz0) * inv_spd
    if t_go < 1.0:
        t_go = 1.0
    for _ in range(max_iter):
        px = dx0 + vtx * t_go
        py = dy0 + vty * t_go
        pz = dz0 + vtz * t_go
        t_new = math.sqrt(px * px + py * py + pz * pz) * inv_spd
        if t_new < 1.0:
            t_new = 1.0
        if abs(t_new - t_go) < 0.5:
            t_go = t_new
            break
        t_go = 0.5 * (t_go + t_new)
    return np.array([rtx + vtx * t_go, rty + vty * t_go, rtz + vtz * t_go]), t_go
