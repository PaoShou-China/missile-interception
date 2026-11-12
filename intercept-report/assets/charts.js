/* Apple-style flight-test dashboard charts (ECharts, SVG renderer). */
(function () {
  var D = window.REPORT_DATA;
  if (!D || !window.echarts) { return; }
  var M = D.meta;
  var S = D.series;

  var css = getComputedStyle(document.documentElement);
  function v(name, fallback) {
    var x = css.getPropertyValue(name);
    return (x && x.trim()) || fallback;
  }
  var accent = v('--accent', '#0071e3');
  var accent2 = v('--accent2', '#30b0c7');
  var ok = v('--ok', '#34c759');
  var warn = v('--warn', '#ff9f0a');
  var ink = v('--ink', '#1d1d1f');
  var muted = v('--muted', '#6e6e73');
  var rule = v('--rule', 'rgba(0,0,0,.08)');
  var font = getComputedStyle(document.body).fontFamily;

  var tooltipStyle = {
    backgroundColor: 'rgba(255,255,255,.96)',
    borderColor: 'rgba(0,0,0,.08)',
    borderWidth: 1,
    padding: [10, 12],
    textStyle: { color: ink, fontSize: 12, fontFamily: font },
    extraCssText: 'box-shadow:0 10px 34px rgba(0,0,0,.12);border-radius:12px;'
  };

  function baseOption(extra) {
    var opt = {
      animation: false,
      textStyle: { fontFamily: font, color: muted },
      grid: { left: 52, right: 26, top: 44, bottom: 38, containLabel: true },
      tooltip: {
        trigger: 'axis',
        appendToBody: true,
        axisPointer: { type: 'line', lineStyle: { color: rule, width: 1 } },
        backgroundColor: tooltipStyle.backgroundColor,
        borderColor: tooltipStyle.borderColor,
        borderWidth: 1,
        padding: tooltipStyle.padding,
        textStyle: tooltipStyle.textStyle,
        extraCssText: tooltipStyle.extraCssText
      },
      legend: {
        top: 6, right: 8, icon: 'circle', itemWidth: 8, itemHeight: 8,
        itemGap: 16, textStyle: { color: muted, fontSize: 11, fontFamily: font }
      }
    };
    for (var k in extra) { if (extra.hasOwnProperty(k)) { opt[k] = extra[k]; } }
    return opt;
  }

  function xTime() {
    return {
      type: 'category',
      boundaryGap: false,
      data: S.time,
      axisLine: { lineStyle: { color: rule } },
      axisTick: { show: false },
      axisLabel: {
        color: muted, fontSize: 10.5, fontFamily: font,
        formatter: function (val) { return Math.round(parseFloat(val)) + 's'; },
        interval: Math.max(1, Math.floor(S.time.length / 8)) - 1
      },
      splitLine: { show: false }
    };
  }

  function yValue(name, extra) {
    var o = {
      type: 'value',
      name: name,
      nameTextStyle: { color: muted, fontSize: 10.5, padding: [0, 0, 4, 0] },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: muted, fontSize: 10.5, fontFamily: font },
      splitLine: { lineStyle: { color: 'rgba(0,0,0,.055)' } }
    };
    for (var k in extra) { if (extra.hasOwnProperty(k)) { o[k] = extra[k]; } }
    return o;
  }

  function mount(id, option) {
    var el = document.getElementById(id);
    if (!el) { return; }
    var chart = echarts.init(el, null, { renderer: 'svg' });
    chart.setOption(option);
    window.addEventListener('resize', function () { chart.resize(); });
  }

  function smoothLine(name, data, color, width) {
    return {
      name: name, type: 'line', data: data, smooth: true, symbol: 'none',
      lineStyle: { width: width || 2, color: color },
      itemStyle: { color: color },
      emphasis: { focus: 'series' }
    };
  }

  var handover = M.handover_time_s;

  /* ---------- 1. altitude profile ---------- */
  (function () {
    var alt = S.alt_km;
    var dr = S.downrange_km;
    var iMax = 0;
    for (var i = 1; i < alt.length; i++) { if (alt[i] > alt[iMax]) { iMax = i; } }
    var pairs = dr.map(function (x, k) { return [x, alt[k]]; });
    var tgtPairs = dr.map(function (x, k) { return [x, S.tgt_alt_km[k]]; });
    var end = pairs[pairs.length - 1];

    var opt = baseOption({});
    opt.grid = { left: 58, right: 30, top: 46, bottom: 42, containLabel: true };
    opt.xAxis = {
      type: 'value', name: 'Range (km)', nameLocation: 'middle', nameGap: 30,
      min: 0, max: Math.ceil((M.downrange_km + 40) / 200) * 200,
      nameTextStyle: { color: muted, fontSize: 11.5, fontFamily: font },
      axisLine: { lineStyle: { color: rule } }, axisTick: { show: false },
      axisLabel: { color: muted, fontSize: 10.5, fontFamily: font },
      splitLine: { lineStyle: { color: 'rgba(0,0,0,.055)' } }
    };
    opt.yAxis = yValue('Altitude (km)', { min: 0, max: 36 });

    opt.series = [
      {
        name: 'Interceptor altitude', type: 'line', data: pairs, smooth: true, symbol: 'none',
        lineStyle: { width: 3, color: accent },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: accent + '33' }, { offset: 1, color: accent + '00' }
          ])
        },
        markPoint: {
          symbol: 'circle', symbolSize: 9,
          itemStyle: { color: accent, borderColor: '#fff', borderWidth: 2 },
          label: {
            show: true, formatter: 'Max altitude ' + M.max_alt_km.toFixed(1) + ' km',
            position: 'top', color: accent, fontSize: 11, fontWeight: 700
          },
          data: [{ coord: [dr[iMax], alt[iMax]] }]
        },
        markLine: {
          symbol: ['none', 'none'], silent: true,
          lineStyle: { color: muted, type: 'dashed', width: 1 },
          label: { formatter: 'Impact', color: muted, fontSize: 10.5 },
          data: [{ xAxis: end[0] }]
        }
      },
      {
        name: 'Target altitude', type: 'line', data: tgtPairs, smooth: false, symbol: 'none',
        lineStyle: { width: 1.6, color: warn, type: 'dashed' },
        itemStyle: { color: warn }
      }
    ];

    if (M.handover_downrange_km) {
      opt.series[0].markLine.data.push({ xAxis: M.handover_downrange_km });
      opt.series[0].markLine.label = {
        formatter: function (p) {
          return p.value === M.handover_downrange_km ? 'Handover' : 'Impact';
        },
        color: muted, fontSize: 10.5
      };
    }
    mount('chart-profile', opt);
  })();

  /* ---------- 2. range vs time ---------- */
  (function () {
    var opt = baseOption({});
    opt.xAxis = xTime();
    opt.yAxis = yValue('km', { min: 0 });
    opt.series = [
      {
        name: 'Interceptor-target range', type: 'line', data: S.range_km, smooth: true, symbol: 'none',
        lineStyle: { width: 2.4, color: accent },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: accent + '2e' }, { offset: 1, color: accent + '00' }
          ])
        },
        markPoint: {
          symbol: 'circle', symbolSize: 9,
          itemStyle: { color: accent, borderColor: '#fff', borderWidth: 2 },
          label: {
            show: true, formatter: '119.6 m', position: 'top',
            color: accent, fontSize: 11, fontWeight: 700
          },
          data: [{ coord: [S.time.length - 1, S.range_km[S.range_km.length - 1]] }]
        },
        markArea: {
          silent: true,
          itemStyle: { opacity: 1 },
          data: [
            [{ xAxis: 0, itemStyle: { color: accent + '10' } },
             { xAxis: M.config.boost_end_s }],
            [{ xAxis: M.config.boost_end_s, itemStyle: { color: 'rgba(0,0,0,.015)' } },
             { xAxis: handover || M.duration_s }],
            [{ xAxis: handover || M.duration_s, itemStyle: { color: warn + '10' } },
             { xAxis: M.duration_s }]
          ]
        }
      }
    ];
    if (handover) {
      opt.series[0].markLine = {
        symbol: ['none', 'none'], silent: true,
        lineStyle: { color: muted, type: 'dashed', width: 1 },
        label: { formatter: 'Handover', color: muted, fontSize: 10.5, position: 'insideEndTop' },
        data: [{ xAxis: handover }]
      };
    }
    mount('chart-range', opt);
  })();

  /* ---------- 3. altitude & speed ---------- */
  (function () {
    var opt = baseOption({});
    opt.grid = { left: 52, right: 60, top: 46, bottom: 38, containLabel: true };
    opt.xAxis = xTime();
    opt.yAxis = [
      yValue('Altitude (km)', { min: 0 }),
      yValue('Speed (m/s)', { min: 0, splitLine: { show: false } })
    ];
    opt.series = [
      {
        name: 'Altitude', type: 'line', yAxisIndex: 0, data: S.alt_km, smooth: true,
        symbol: 'none', lineStyle: { width: 2.2, color: accent },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: accent + '30' }, { offset: 1, color: accent + '00' }
          ])
        }
      },
      smoothLine('Speed', S.speed, accent2, 2)
    ];
    opt.series[1].yAxisIndex = 1;
    mount('chart-energy', opt);
  })();

  /* ---------- 4. load factor ---------- */
  (function () {
    var opt = baseOption({});
    opt.xAxis = xTime();
    opt.yAxis = yValue('g', { min: 0, max: 44 });
    opt.series = [
      smoothLine('Commanded', S.load_cmd, accent, 2),
      smoothLine('Actual', S.load_act, warn, 1.8)
    ];
    opt.series[1].lineStyle.type = 'dashed';
    mount('chart-load', opt);
  })();

  /* ---------- 5. fin deflections ---------- */
  (function () {
    var opt = baseOption({});
    opt.xAxis = xTime();
    opt.yAxis = yValue('deg', { min: -28, max: 28 });
    opt.series = [
      smoothLine('Up fin', S.fin_up, accent, 1.7),
      smoothLine('Down fin', S.fin_down, accent2, 1.7),
      smoothLine('Left fin', S.fin_left, ok, 1.7),
      smoothLine('Right fin', S.fin_right, warn, 1.7)
    ];
    mount('chart-fins', opt);
  })();

  /* ---------- 6. navigation error ---------- */
  (function () {
    var data = S.nav_err.map(function (x) { return x > 0.05 ? x : null; });
    var opt = baseOption({});
    opt.xAxis = xTime();
    opt.yAxis = yValue('m', {
      type: 'log', min: 0.1,
      axisLabel: {
        color: muted, fontSize: 10.5, fontFamily: font,
        formatter: function (val) { return val >= 1 ? val : val.toFixed(1); }
      }
    });
    opt.series = [smoothLine('Nav error', data, ink, 1.6)];
    mount('chart-nav', opt);
  })();

  /* ---------- 7. handover metrics ---------- */
  (function () {
    var opt = baseOption({});
    opt.grid = { left: 52, right: 58, top: 46, bottom: 38, containLabel: true };
    opt.xAxis = xTime();
    opt.yAxis = [
      yValue('ΔH (km)', { min: 0 }),
      yValue('Lead angle (deg)', { min: 0, splitLine: { show: false } })
    ];
    var dh = smoothLine('ΔH', S.dh_km, accent, 2);
    dh.areaStyle = {
      color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
        { offset: 0, color: accent + '22' }, { offset: 1, color: accent + '00' }
      ])
    };
    var lead = smoothLine('Lead angle', S.lead_deg, warn, 1.8);
    lead.yAxisIndex = 1;
    opt.series = [dh, lead];
    if (handover) {
      opt.series[0].markLine = {
        symbol: ['none', 'none'], silent: true,
        lineStyle: { color: muted, type: 'dashed', width: 1 },
        label: { formatter: 'Handover', color: muted, fontSize: 10.5, position: 'insideEndTop' },
        data: [{ xAxis: handover }]
      };
    }
    mount('chart-handover', opt);
  })();

  /* ---------- 8. seeker FOV ---------- */
  (function () {
    var opt = baseOption({});
    opt.xAxis = xTime();
    opt.yAxis = yValue('deg', { min: 0, max: 95 });
    opt.series = [
      {
        name: 'LOS off-boresight', type: 'line', data: S.fov_deg, smooth: true, symbol: 'none',
        lineStyle: { width: 2, color: accent },
        markLine: {
          symbol: ['none', 'none'], silent: true,
          lineStyle: { color: warn, type: 'dashed', width: 1.2 },
          label: { formatter: 'FOV 20°', color: warn, fontSize: 10.5, position: 'insideEndTop' },
          data: [{ yAxis: 20 }]
        },
        markArea: {
          silent: true,
          itemStyle: { color: warn + '0d' },
          data: [[{ yAxis: 20 }, { yAxis: 95 }]]
        }
      }
    ];
    if (handover) {
      opt.series[0].markLine.data.push({ xAxis: handover });
    }
    mount('chart-fov', opt);
  })();
})();
