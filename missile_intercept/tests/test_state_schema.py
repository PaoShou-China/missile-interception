"""State-schema layout contract: names, slices and hash must stay stable."""

import state_schema as S


def test_system_layout_matches_compiled_core():
    """The compiled kernels use this exact contiguous layout."""
    schema = S.SYSTEM_SCHEMA
    assert schema.total_size == 20
    expected = {
        "m_position": (0, 3),
        "m_velocity": (3, 6),
        "m_attitude": (6, 10),
        "m_angular_rate": (10, 13),
        "m_mass": (13, 14),
        "t_position": (14, 17),
        "t_velocity": (17, 20),
    }
    for key, (start, stop) in expected.items():
        sl = schema.sl[key]
        assert (sl.start, sl.stop) == (start, stop), key


def test_pack_unpack_round_trip():
    values = {
        "m_position": [1.0, 2.0, 3.0],
        "m_velocity": [4.0, 5.0, 6.0],
        "m_attitude": [1.0, 0.0, 0.0, 0.0],
        "m_angular_rate": [0.1, 0.2, 0.3],
        "m_mass": 1000.0,
        "t_position": [7.0, 8.0, 9.0],
        "t_velocity": [10.0, 11.0, 12.0],
    }
    packed = S.SYSTEM_SCHEMA.pack(values)
    out = S.SYSTEM_SCHEMA.unpack(packed)
    assert out["m_mass"] == 1000.0
    assert out["t_velocity"].tolist() == [10.0, 11.0, 12.0]


def test_layout_hash_is_present():
    assert len(S.SYSTEM_SCHEMA.layout_hash) == 64
    assert S.SYSTEM_SCHEMA.layout_hash != S.MISSILE_SCHEMA.layout_hash
