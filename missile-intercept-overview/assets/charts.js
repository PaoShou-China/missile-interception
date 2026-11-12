// Repository overview charts — data from assets/data.js (window.REPORT_DATA)
(function () {
  if (!window.REPORT_DATA || !window.echarts) return;

  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim();
  var accent2 = style.getPropertyValue('--accent2').trim();
  var ink = style.getPropertyValue('--ink').trim();
  var muted = style.getPropertyValue('--muted').trim();
  var rule = style.getPropertyValue('--rule').trim();
  var bg2 = style.getPropertyValue('--bg2').trim();

  var D = window.REPORT_DATA;
  var S = D.series;

  // Fresh option object for every axis (ECharts mutates options it receives).
  function axis(extra) {
    return Object.assign({
      axisLine: { lineStyle: { color: rule } },
      axisTick: { show: false },
      axisLabel: { color: muted, fontSize: 11 },
      splitLine: { lineStyle: { color: rule } }
    }, extra);
  }

  function tip(extra) {
    return Object.assign({
      trigger: 'axis',
      appendToBody: true,
      backgroundColor: bg2,
      borderColor: rule,
      textStyle: { color: ink, fontSize: 12 },
      axisPointer: { lineStyle: { color: muted } }
    }, extra);
  }

  function init(id) {
    var el = document.getElementById(id);
    if (!el) return null;
    return echarts.init(el, null, { renderer: 'svg' });
  }

  // ---------- 1. altitude vs downrange ----------
  var altData = S.downrange_km.map(function (x, i) { return [x, S.alt_km[i]]; });
  var c1 = init('chart-alt');
  if (c1) {
    c1.setOption({
      animation: false,
      grid: { left: 48, right: 20, top: 24, bottom: 42 },
      tooltip: tip({
        formatter: function (p) {
          var v = p[0].value;
          return '航程 ' + v[0].toFixed(0) + ' km<br/>高度 ' + v[1].toFixed(1) + ' km';
        }
      }),
      xAxis: axis({
        type: 'value', name: '航程 (km)', nameTextStyle: { color: muted, fontSize: 11 },
        nameLocation: 'middle', nameGap: 28, min: 0
      }),
      yAxis: axis({
        type: 'value', name: '高度 (km)', nameTextStyle: { color: muted, fontSize: 11 },
        nameGap: 38, min: 0
      }),
      series: [{
        type: 'line',
        data: altData,
        showSymbol: false,
        smooth: true,
        lineStyle: { color: accent, width: 2.2 },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: accent + '40' },
              { offset: 1, color: accent + '05' }
            ]
          }
        }
      }]
    });
    window.addEventListener('resize', function () { c1.resize(); });
  }

  // ---------- 2. speed & dynamic pressure ----------
  var c2 = init('chart-speed');
  if (c2) {
    c2.setOption({
      animation: false,
      grid: { left: 52, right: 56, top: 34, bottom: 42 },
      tooltip: tip(),
      legend: {
        data: ['速度', '动压'],
        top: 0, right: 0,
        itemWidth: 14, itemHeight: 8,
        textStyle: { color: muted, fontSize: 11 }
      },
      xAxis: axis({
        type: 'category', data: S.time, boundaryGap: false,
        name: '时间 (s)', nameTextStyle: { color: muted, fontSize: 11 },
        nameLocation: 'middle', nameGap: 28
      }),
      yAxis: [
        axis({
          type: 'value', name: '速度 (m/s)', nameTextStyle: { color: muted, fontSize: 11 },
          nameGap: 40, min: 0
        }),
        axis({
          type: 'value', name: '动压 (kPa)', nameTextStyle: { color: muted, fontSize: 11 },
          nameGap: 38, min: 0, splitLine: { show: false }
        })
      ],
      series: [
        {
          name: '速度', type: 'line', data: S.speed, showSymbol: false, smooth: true,
          lineStyle: { color: accent, width: 2.2 }
        },
        {
          name: '动压', type: 'line', yAxisIndex: 1, data: S.q_kpa, showSymbol: false, smooth: true,
          lineStyle: { color: accent2, width: 1.8 }, areaStyle: { color: accent2 + '18' }
        }
      ]
    });
    window.addEventListener('resize', function () { c2.resize(); });
  }

  // ---------- 3. ground track ----------
  var missileTrack = S.miss_east_km.map(function (x, i) { return [x, S.miss_north_km[i]]; });
  var targetTrack = S.tgt_east_km.map(function (x, i) { return [x, S.tgt_north_km[i]]; });
  var c3 = init('chart-track');
  if (c3) {
    c3.setOption({
      animation: false,
      grid: { left: 56, right: 24, top: 34, bottom: 44 },
      tooltip: tip({
        formatter: function (p) {
          var v = p.value;
          return p.seriesName + '<br/>东向 ' + v[0].toFixed(0) + ' km<br/>北向 ' + v[1].toFixed(0) + ' km';
        }
      }),
      legend: {
        data: ['导弹', '目标'],
        top: 0, right: 0,
        itemWidth: 14, itemHeight: 8,
        textStyle: { color: muted, fontSize: 11 }
      },
      xAxis: axis({
        type: 'value', name: '东向 (km)', nameTextStyle: { color: muted, fontSize: 11 },
        nameLocation: 'middle', nameGap: 28, scale: true
      }),
      yAxis: axis({
        type: 'value', name: '北向 (km)', nameTextStyle: { color: muted, fontSize: 11 },
        nameGap: 42, scale: true
      }),
      series: [
        {
          name: '导弹', type: 'line', data: missileTrack, showSymbol: false, smooth: true,
          lineStyle: { color: accent, width: 2.4 },
          markPoint: {
            symbolSize: 34,
            label: { color: bg2, fontSize: 10, fontWeight: 600 },
            data: [{ type: 'max', name: '终点', valueIndex: -1 }]
          }
        },
        {
          name: '目标', type: 'line', data: targetTrack, showSymbol: false, smooth: true,
          lineStyle: { color: accent2, width: 1.6, type: 'dashed' }
        }
      ]
    });
    window.addEventListener('resize', function () { c3.resize(); });
  }

  // ---------- 4. lines of code by module ----------
  var loc = [
    { name: 'tools', value: 1501 },
    { name: 'fastcore', value: 1334 },
    { name: 'tests', value: 967 },
    { name: 'vehicle', value: 912 },
    { name: 'guidance', value: 880 },
    { name: 'config', value: 852 },
    { name: 'main', value: 774 },
    { name: 'sensors', value: 629 },
    { name: 'control', value: 574 },
    { name: 'visualization', value: 459 },
    { name: 'validate_performance', value: 456 },
    { name: 'batch', value: 453 },
    { name: 'analysis', value: 403 },
    { name: 'math_utils', value: 380 },
    { name: 'integrator', value: 303 },
    { name: 'verification', value: 223 }
  ];
  var c4 = init('chart-loc');
  if (c4) {
    c4.setOption({
      animation: false,
      grid: { left: 132, right: 46, top: 12, bottom: 20 },
      tooltip: tip({
        trigger: 'item',
        formatter: function (p) { return p.name + '<br/>' + p.value + ' 行'; }
      }),
      xAxis: axis({ type: 'value', minInterval: 200 }),
      yAxis: axis({
        type: 'category',
        data: loc.map(function (d) { return d.name; }),
        axisLabel: { color: muted, fontSize: 11, fontFamily: 'SF Mono, Consolas, monospace' }
      }),
      series: [{
        type: 'bar',
        data: loc.map(function (d) { return d.value; }),
        barWidth: 13,
        itemStyle: {
          color: accent + 'cc',
          borderRadius: [0, 4, 4, 0]
        },
        label: { show: true, position: 'right', color: muted, fontSize: 10 }
      }]
    });
    window.addEventListener('resize', function () { c4.resize(); });
  }
})();
