// Result charts with bilingual axes. Data comes from assets/data.js.
(function () {
  if (!window.REPORT_DATA || !window.echarts) return;

  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim();
  var accent2 = style.getPropertyValue('--accent2').trim();
  var ink = style.getPropertyValue('--ink').trim();
  var muted = style.getPropertyValue('--muted').trim();
  var rule = style.getPropertyValue('--rule').trim();
  var bg2 = style.getPropertyValue('--bg2').trim();

  var S = window.REPORT_DATA.series;
  var MC = window.MC_DATA || null;
  var lang = document.body.classList.contains('lang-en') ? 'en' : 'zh';
  var instances = {};
  var rendered = {};

  var TEXT = {
    zh: {
      alt: { x: '航程 (km)', y: '高度 (km)', tipX: '航程', tipY: '高度', phases: ['助推', '中制导', '末制导'] },
      speed: { x: '时间 (s)', y1: '速度 (m/s)', y2: '动压 (kPa)', legend: ['速度', '动压'] },
      track: { x: '东向 (km)', y: '北向 (km)', legend: ['导弹', '目标'] },
      load: { x: '时间 (s)', y: '过载 (g)', legend: ['指令过载', '实际过载'] },
      mc: { x: '脱靶量区间', y: '样本数', unit: '例' }
    },
    en: {
      alt: { x: 'Downrange (km)', y: 'Altitude (km)', tipX: 'Downrange', tipY: 'Altitude', phases: ['Boost', 'Midcourse', 'Terminal'] },
      speed: { x: 'Time (s)', y1: 'Speed (m/s)', y2: 'Dynamic pressure (kPa)', legend: ['Speed', 'Q'] },
      track: { x: 'East (km)', y: 'North (km)', legend: ['Missile', 'Target'] },
      load: { x: 'Time (s)', y: 'Load factor (g)', legend: ['Commanded', 'Measured'] },
      mc: { x: 'Miss-distance bin', y: 'Case count', unit: 'cases' }
    }
  };

  function axis(extra) {
    return Object.assign({
      axisLine: { lineStyle: { color: rule } },
      axisTick: { show: false },
      axisLabel: { color: muted, fontSize: 10.5 },
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

  function instance(id) {
    var el = document.getElementById(id);
    if (!el) return null;
    if (!instances[id]) instances[id] = echarts.init(el, null, { renderer: 'svg' });
    return instances[id];
  }

  function phaseBounds() {
    var ph = S.phase;
    var dr = S.downrange_km;
    var i1 = -1, i2 = -1;
    for (var i = 0; i < ph.length; i++) {
      if (i1 < 0 && ph[i] >= 1) i1 = i;
      if (i2 < 0 && ph[i] >= 2) { i2 = i; break; }
    }
    var end = dr[dr.length - 1];
    return {
      b1: i1 >= 0 ? dr[i1] : end,
      b2: i2 >= 0 ? dr[i2] : end,
      end: end
    };
  }

  function altOption(t) {
    var data = S.downrange_km.map(function (x, i) { return [x, S.alt_km[i]]; });
    var pb = phaseBounds();
    return {
      animation: false,
      grid: { left: 48, right: 18, top: 30, bottom: 40 },
      tooltip: tip({
        formatter: function (p) {
          var v = p[0].value;
          return t.tipX + ' ' + v[0].toFixed(0) + ' km<br/>' + t.tipY + ' ' + v[1].toFixed(1) + ' km';
        }
      }),
      xAxis: axis({
        type: 'value', name: t.x, nameTextStyle: { color: muted, fontSize: 10.5 },
        nameLocation: 'middle', nameGap: 27, min: 0
      }),
      yAxis: axis({
        type: 'value', name: t.y, nameTextStyle: { color: muted, fontSize: 10.5 },
        nameGap: 36, min: 0
      }),
      series: [{
        type: 'line', data: data, showSymbol: false, smooth: true,
        lineStyle: { color: accent, width: 2.2 },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: accent + '40' },
              { offset: 1, color: accent + '05' }
            ]
          }
        },
        markArea: {
          silent: true,
          label: { show: true, position: 'insideTop', color: muted, fontSize: 11 },
          data: [
            [{ name: t.phases[0], xAxis: 0, itemStyle: { color: accent + '12' } }, { xAxis: pb.b1 }],
            [{ name: t.phases[1], xAxis: pb.b1, itemStyle: { color: accent2 + '12' } }, { xAxis: pb.b2 }],
            [{ name: t.phases[2], xAxis: pb.b2, itemStyle: { color: ink + '0d' } }, { xAxis: pb.end }]
          ]
        }
      }]
    };
  }

  function speedOption(t) {
    return {
      animation: false,
      grid: { left: 50, right: 56, top: 32, bottom: 40 },
      tooltip: tip(),
      legend: {
        data: t.legend, top: 0, right: 0, itemWidth: 14, itemHeight: 8,
        textStyle: { color: muted, fontSize: 10.5 }
      },
      xAxis: axis({
        type: 'category', data: S.time, boundaryGap: false,
        name: t.x, nameTextStyle: { color: muted, fontSize: 10.5 },
        nameLocation: 'middle', nameGap: 27
      }),
      yAxis: [
        axis({
          type: 'value', name: t.y1, nameTextStyle: { color: muted, fontSize: 10.5 },
          nameGap: 38, min: 0
        }),
        axis({
          type: 'value', name: t.y2, nameTextStyle: { color: muted, fontSize: 10.5 },
          nameGap: 38, min: 0, splitLine: { show: false }
        })
      ],
      series: [
        { name: t.legend[0], type: 'line', data: S.speed, showSymbol: false, smooth: true,
          lineStyle: { color: accent, width: 2.2 } },
        { name: t.legend[1], type: 'line', yAxisIndex: 1, data: S.q_kpa, showSymbol: false, smooth: true,
          lineStyle: { color: accent2, width: 1.7 }, areaStyle: { color: accent2 + '18' } }
      ]
    };
  }

  function trackOption(t) {
    var missile = S.miss_east_km.map(function (x, i) { return [x, S.miss_north_km[i]]; });
    var target = S.tgt_east_km.map(function (x, i) { return [x, S.tgt_north_km[i]]; });
    return {
      animation: false,
      grid: { left: 54, right: 22, top: 32, bottom: 42 },
      tooltip: tip({
        formatter: function (p) {
          var v = p.value;
          return p.seriesName + '<br/>' + t.x + ' ' + v[0].toFixed(0) + ' km<br/>' + t.y + ' ' + v[1].toFixed(0) + ' km';
        }
      }),
      legend: {
        data: t.legend, top: 0, right: 0, itemWidth: 14, itemHeight: 8,
        textStyle: { color: muted, fontSize: 10.5 }
      },
      xAxis: axis({
        type: 'value', name: t.x, nameTextStyle: { color: muted, fontSize: 10.5 },
        nameLocation: 'middle', nameGap: 27, scale: true
      }),
      yAxis: axis({
        type: 'value', name: t.y, nameTextStyle: { color: muted, fontSize: 10.5 },
        nameGap: 40, scale: true
      }),
      series: [
        { name: t.legend[0], type: 'line', data: missile, showSymbol: false, smooth: true,
          lineStyle: { color: accent, width: 2.4 } },
        { name: t.legend[1], type: 'line', data: target, showSymbol: false, smooth: true,
          lineStyle: { color: accent2, width: 1.6, type: 'dashed' } }
      ]
    };
  }

  function loadOption(t) {
    return {
      animation: false,
      grid: { left: 50, right: 22, top: 32, bottom: 40 },
      tooltip: tip(),
      legend: {
        data: t.legend, top: 0, right: 0, itemWidth: 14, itemHeight: 8,
        textStyle: { color: muted, fontSize: 10.5 }
      },
      xAxis: axis({
        type: 'category', data: S.time, boundaryGap: false,
        name: t.x, nameTextStyle: { color: muted, fontSize: 10.5 },
        nameLocation: 'middle', nameGap: 27
      }),
      yAxis: axis({
        type: 'value', name: t.y, nameTextStyle: { color: muted, fontSize: 10.5 },
        nameGap: 38, min: 0
      }),
      series: [
        { name: t.legend[0], type: 'line', data: S.load_cmd, showSymbol: false,
          lineStyle: { color: accent, width: 1.6 } },
        { name: t.legend[1], type: 'line', data: S.load_act, showSymbol: false,
          lineStyle: { color: accent2, width: 1.8 } }
      ]
    };
  }

  function mcOption(t) {
    var bins = (MC && MC.meta.bins) || [];
    var cats = bins.map(function (b) { return lang === 'zh' ? b.zh : b.en; });
    var vals = bins.map(function (b) { return b.count; });
    return {
      animation: false,
      grid: { left: 48, right: 18, top: 24, bottom: 46 },
      tooltip: tip({
        trigger: 'item',
        formatter: function (p) { return p.name + '<br/>' + p.value + ' ' + t.unit; }
      }),
      xAxis: axis({
        type: 'category', data: cats,
        name: t.x, nameTextStyle: { color: muted, fontSize: 10.5 },
        nameLocation: 'middle', nameGap: 30
      }),
      yAxis: axis({
        type: 'value', name: t.y, nameTextStyle: { color: muted, fontSize: 10.5 },
        nameGap: 36, min: 0, minInterval: 1
      }),
      series: [{
        type: 'bar',
        data: vals,
        barMaxWidth: 46,
        itemStyle: { color: accent + 'cc', borderRadius: [6, 6, 0, 0] },
        label: { show: true, position: 'top', color: muted, fontSize: 11 }
      }]
    };
  }

  var DEFS = [
    { id: 'chart-alt', type: 'alt' },
    { id: 'chart-alt2', type: 'alt' },
    { id: 'chart-speed', type: 'speed' },
    { id: 'chart-track', type: 'track' },
    { id: 'chart-load', type: 'load' },
    { id: 'chart-mc', type: 'mc' }
  ];

  function renderVisible() {
    var t = TEXT[lang];
    DEFS.forEach(function (def) {
      var el = document.getElementById(def.id);
      if (!el || !el.offsetWidth) return; // hidden page: render when it becomes active
      if (def.type === 'mc' && !MC) return;
      var chart = instance(def.id);
      if (!chart) return;
      var opt = def.type === 'alt' ? altOption(t.alt)
        : def.type === 'speed' ? speedOption(t.speed)
        : def.type === 'track' ? trackOption(t.track)
        : def.type === 'load' ? loadOption(t.load)
        : mcOption(t.mc);
      chart.setOption(opt, true);
      chart.resize();
    });
  }

  function resizeVisible() {
    DEFS.forEach(function (def) {
      if (instances[def.id]) instances[def.id].resize();
    });
  }

  window.addEventListener('overview:lang', function (e) {
    lang = e.detail === 'en' ? 'en' : 'zh';
    renderVisible();
    setTimeout(resizeVisible, 60);
  });

  window.addEventListener('overview:page', function () {
    setTimeout(renderVisible, 60);
  });

  window.addEventListener('resize', resizeVisible);

  renderVisible();
})();
