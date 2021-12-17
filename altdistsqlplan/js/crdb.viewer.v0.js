
// Copyright 2021 The Cockroach Authors.
//
// Use of this software is governed
// by the Apache License, Version 2.0, included in the file
// LICENSE
const crdb_CONFIG = {
  margin: { top: 20, right: 20, bottom: 20, left: 20 },
  dim: { width: window.innerWidth, height: window.innerHeight },
  dag: {
    nodeRadius: 50, // defines the radius of the circle that "covers" each node in the DAG for layout purposes.
    synchOffset: 15, // how far from center on x axis unordered/ordered synchronizers are displayed.
    nodeAnchor: {  // where to connect edges to the node on the y axis
      top: 10,
      bottom: 70
    },
    maxRows: 8, // maximum number of rows displayed a node
    nodeDim: {
      height: 80,
      width: 140,
      x: -70,
      y: -10,
      rx: 15
    }
  }
}

var crdb_DATA = null;
var crdb_SELECTED = new Set()
var crdb_IDS = []
var crdb_DEBUG_LABELS = new Set(); //["init"]

var crdb_METRICS = {
  "main": {
    exec: "execution time",
    mem: "max memory allocated",
    disk: "max scratch disk allocated"
  },
  "kv": {
    time: "KV time",
    cont: "KV contention time",
    rows: "KV rows read",
    bytes: "KV bytes read"
  },
  "in": {
    rows: "input rows"
  },
  "out": {
    cols: "cols output",
    rows: "rows output",
    batches: "batches output"
  }
}

var crdb_UNITS = {
  "execution time": "duration",
  "max memory allocated": "bytes",
  "max scratch disk allocated": "bytes",
  "KV time": "duration",
  "KV contention time": "duration",
  "KV bytes read": "bytes",
  "network latency": "duration",
  "network wait time": "duration",
  "deserialization time": "duration",
  "network bytes received": "bytes",
  "max sql temp disk usage": "bytes"
}

// Utility functions
function crdb_humanFormat(label, value) {
  var s;
  const type = crdb_UNITS[label]
  if (type === "bytes") {
    s = HRNumbers.toHumanString(value) + "B"
  } else if (type === "duration") {
    if (value >= 60000000) {
      s = (value / 60000000).toFixed(1) + "M"
    } else if (value >= 1000000) {
      s = (value / 1000000).toFixed(1) + "S"
    } else if (value >= 1000) {
      s = (value / 1000).toFixed(0) + "ms"
    } else {
      s = value + "µs"
    }
  } else {
    s = HRNumbers.toHumanString(value)
  }
  return s
}

function crdb_debug(label, msg) {
  if (crdb_DEBUG_LABELS.has(label)) {
    console.log(label)
    console.log(msg)
  }
}

function crdb_parseTime(time) {
  var t = parse.substring(parse.indexOf(":") + 1).split(" ")
  return parseInt(t[0])
}

function crdb_getTiming(details) {
  time = 0
  detail.filter(att => att.includes("time:"))
    .forEach(e => time + crdb_parseTime(e)
    )
}

function crdb_normalizeUnits(v) {
  if (v.includes("µs")) return parseFloat(v)
  if (v.includes("ms")) return parseFloat(v) * 1000
  if (v.endsWith("s")) return parseFloat(v) * (1000 ** 2)
  if (v.endsWith("KiB")) return parseInt(parseFloat(v) * 1024)
  if (v.endsWith("MiB")) return parseInt(parseFloat(v) * (1024 ** 2))
  if (v.endsWith("GiB")) return parseInt(parseFloat(v) * (1024 ** 3))
  if (v.endsWith("B")) return parseInt(v)
  if (v.includes(",")) {
    t = v.replaceAll(",", "")
    r = parseFloat(t)
    if (isNaN(r)) return v
    else return r
  }
  r = parseFloat(v)
  if (isNaN(r)) return v
  else return r
}

function crdb_trimText(text, threshold) {
  if (text.length <= threshold) return text;
  return text.substr(0, threshold).concat("...");
}

// Decode the data
function crdb_getData() {
  var compressed = window.location.hash;
  if (window.location.hash.length <= 1) {
    return null
  }
  compressed = compressed.substring(1, compressed.length)
  // Decode base64 (convert ascii to binary).
  var strData = atob(compressed.replace(/-/g, '+').replace(/_/g, '/'));
  // Convert binary string to character-number array
  var charData = strData.split('').map(function (x) { return x.charCodeAt(0); });
  // Turn number array into byte-array
  var binData = new Uint8Array(charData);
  // Pako magic
  var data = pako.inflate(binData);
  var strData = new TextDecoder("utf-8").decode(data)
  return JSON.parse(strData);
}

// Zoom 
function crdb_zoom(svg, actualWidth, actualHeight) {
  var g = svg.append("g")
  var zoom = d3.zoom()
    .scaleExtent([0.1, 10])
    .on('zoom', function (event) {
      g.attr('transform', event.transform);
    });
  var targetWidth = crdb_CONFIG.dim.width - crdb_CONFIG.margin.left - crdb_CONFIG.margin.right;
  var targetHeight = crdb_CONFIG.dim.height - crdb_CONFIG.margin.top - crdb_CONFIG.margin.bottom;
  var scaleX = targetWidth / actualWidth;
  var scaleY = targetHeight / actualHeight;
  var scale = Math.max(Math.min(scaleX, scaleY), .5);
  svg.call(zoom.transform, d3.zoomIdentity
    .translate(
      targetWidth / 2 - actualWidth * scale / 2 + crdb_CONFIG.margin.left,
      targetHeight / 2 - actualHeight * scale / 2 + crdb_CONFIG.margin.top)
    .scale(scale)
  );
  svg.call(zoom);
  return g
}

// DAG 
function crdb_newDagContainer(id) {
  svg = d3.select(id).html("")
  svg = d3.select(id).append("svg")
  return svg
}

function crdb_drawEdges(container, height, links, linksInfo) {
  const synchOffset = crdb_CONFIG.dag.synchOffset
  const anchor = crdb_CONFIG.dag.nodeAnchor
  const line = d3
    .line()
    .curve(d3.curveCatmullRom)
    .x((d) => d.x)
    .y((d) => (height - d.y));
  container
    .append("g")
    .selectAll("path")
    .data(links)
    .enter()
    .append("path")
    .attr("d", (d) => {
      source = d.source
      points = d.points
      el = linksInfo[d.data[1] + "-" + d.data[0]]
      dx = points[0].x
      if (el.destInput > 0) {
        type = crdb_DATA.processors[el.destProc].inputs[el.destInput - 1].title
        if (type === "ordered") {
          points[0].x = dx - synchOffset
        } else if (type === "unordered") {
          points[0].x = dx + synchOffset
        }
      }
      points[0].y = points[0].y + anchor.top
      points[1].y = points[1].y - anchor.bottom
      return line(points)
    })
    // dashed line for unordered synch
    .attr("stroke-dasharray", (d) => {
      source = d.source
      points = d.points
      el = linksInfo[d.data[1] + "-" + d.data[0]]
      if (el.destInput > 0) {
        type = crdb_DATA.processors[el.destProc].inputs[el.destInput - 1].title
        if (type == "unordered") {
          return 1
        }
      }
      return 0
    }
    )
    .attr("class", "edge")
    .attr("stroke", "gray")
    .attr("stroke-width", "0.01%")
    .attr("id", (d) => {
      f = d.data[1]
      t = d.data[0]
      crdb_IDS.push("id_" + f + "-" + t)
      return "id_" + f + "-" + t
    })
  // add  thicker transparent edges for hovering
  container
    .append("g")
    .selectAll("path")
    .data(links)
    .enter()
    .append("path")
    .attr("d", ({ source, points }) => {
      return line(points)
    })
    .attr("class", "edge")
    .attr("stroke", "transparent")
    .attr("stroke-width", "0.1%")
    .each(function (d) {
      crdb_edgeEvents(d3.select(this), linksInfo[d.data[1] + "-" + d.data[0]].stats)
    })
}

function crdb_drawBox(nodes, data) {
  const dim = crdb_CONFIG.dag.nodeDim
  nodes
    .append("rect")
    .attr("id", (d, i) => {
      crdb_IDS.push("id_" + d.data.id)
      return "id_" + d.data.id
    })
    .attr("rx", dim.rx)
    .attr("height", dim.height)
    .attr("width", dim.width)
    .attr("x", dim.x)
    .attr("y", dim.y)
    .attr("stroke-width", "1px")
    .attr("fill-opacity", .50)
    .attr("stroke", "#DDDDDD")
    .attr("fill", "#FFFFFF")

}

// TODO remove hardcoded numbers
function crdb_synchronizer(nodes, data, type) {
  var x = -16
  var y = -10
  var r = 5
  var t = "O"
  if (type === "unordered") {
    x = 16
    t = "U"
  }
  nodes
    .filter((d) => (data.processors[parseInt(d.data.id)]
      .inputs.filter(e => e.title === type).length > 0))
    .append("circle")
    .attr("r", r)
    .attr("cx", x)
    .attr("cy", y)
    .attr("fill-opacity", 1)
    .attr("fill", "blue")
  nodes
    .filter((d) => (data.processors[parseInt(d.data.id)]
      .inputs.filter(e => e.title === type).length > 0))
    .append("text")
    .text(t)
    .attr("r", r)
    .attr("x", x)
    .attr("y", y + 1)
    .attr("font-size", "0.5em")
    .attr("font-weight", "bold")
    .attr("text-anchor", "middle")
    .attr("alignment-baseline", "middle")
    .attr("fill", "white")
}

function crdb_router(nodes, data) {
  var x = 0
  var y = 70
  var r = 5
  var t = "H"
  nodes
    .filter((d) => (data.processors[parseInt(d.data.id)].outputs.length > 0))
    .append("circle")
    .attr("r", r)
    .attr("cx", x)
    .attr("cy", y)
    .attr("fill-opacity", 1)
    .attr("fill", "orange")

  nodes
    .filter((d) => (data.processors[parseInt(d.data.id)].outputs.length > 0))
    .append("text")
    .text("H")
    .attr("r", r)
    .attr("x", x)
    .attr("y", y + 1)
    .attr("font-size", "0.5em")
    .attr("font-weight", "bold")
    .attr("text-anchor", "middle")
    .attr("alignment-baseline", "middle")
    .attr("fill", "white")
}

function crdb_nodeId(nodes, data) {
  rx = 10
  x = -66
  y = -5
  h = 10
  w = crdb_CONFIG.dag.nodeRadius + 10
  nodes
    .append("text")
    .text((d, i) => {
      return "Node#" +
        data.nodeNames[data.processors[parseInt(d.data.id)].nodeIdx]
    })
    .attr("font-size", "0.25em")
    .attr("font-family", "sans-serif")
    .attr("x", x + crdb_CONFIG.dag.nodeRadius / 2)
    .attr("text-anchor", "middle")
    .attr("alignment-baseline", "middle")
    .attr("fill", "black");
  nodes
    .append("rect")
    .attr("name", (d) => ('node_' + data.nodeNames[data.processors[parseInt(d.data.id)].nodeIdx]))
    .attr("rx", rx)
    .attr("height", h)
    .attr("width", w)
    .attr("x", x)
    .attr("y", y)
    .attr("fill-opacity", .40)
    .attr("fill", "#DDDDDD")
    .on("click", function (event, d) {
      s = "[name~=" + d3.select(this).attr("name") + "]"
      a = d3.select(this).attr("fill")
      if (a === "#DDDDDD") {
        d3.selectAll(s).attr("fill", d3.interpolateRainbow(Math.random()))
      }
      else {
        d3.selectAll(s).attr("fill", "#DDDDDD")
      }
    }
    )
}

function crdb_processorId(nodes, data) {
  rx = 10
  x = 1
  y = -5
  h = 10
  w = crdb_CONFIG.dag.nodeRadius + 10
  nodes
    .append("text")
    .text((d) => {
      return data.processors[parseInt(d.data.id)].core.title
    })
    .attr("font-size", "0.25em")
    .attr("font-family", "sans-serif")
    .attr("x", x + crdb_CONFIG.dag.nodeRadius / 2)
    .attr("text-anchor", "middle")
    .attr("alignment-baseline", "middle")
    .attr("fill", "black");
  nodes
    .append("rect")
    .attr("name", (d) => ('ops_' + data.processors[parseInt(d.data.id)].core.title.split('/')[0].replaceAll(" ", "_")))
    .attr("rx", rx)
    .attr("height", h)
    .attr("width", w)
    .attr("x", x)
    .attr("y", y)
    .attr("fill-opacity", .40)
    .attr("fill", "#DDDDDD")
    .each(function (d) {
      details = data.processors[parseInt(d.data.id)].core.details
      data.processors[parseInt(d.data.id)].inputs.forEach((element, index) =>
        details.push("input_" + index + ": " + element.title + " " + element.details.join(","))
      )
      data.processors[parseInt(d.data.id)].outputs.forEach((element, index) =>
        details.push("output_" + index + ": " + element.title + " " + element.details.join(","))
      )
      crdb_tooltipEvents(d3.select(this), details)
    }
    )
}

function crdb_drawBoxHeader(nodes, data) {
  crdb_synchronizer(nodes, data, "ordered")
  crdb_synchronizer(nodes, data, "unordered")
  crdb_router(nodes, data)
  crdb_nodeId(nodes, data)
  crdb_processorId(nodes, data)
}

function crdb_drawNodes(container, height, dag, data) {
  // Box Containers 
  const nodes = svgSelection
    .append("g")
    .selectAll("g")
    .data(dag.descendants())
    .enter()
    .append("g")
    .attr("class", "node")
    .attr("transform", ({ x, y }) => { y = height - y; return `translate(${x},  ${y})` });
  crdb_drawBox(nodes, data)
  crdb_drawBoxHeader(nodes, data)
  // Metrics
  nodes
    .append((d) => {
      core = data.processors[parseInt(d.data.id)].core
      return crdb_displayDetails(core)
    }
    )
}

// TODO: remove hardcoded values
function crdb_displayMetric(container, rect, name, key, value) {
  const r = 2, yoffset = 10, ytextoffset = 14, height = 5, width = 28;
  magnitude = Math.round(Math.log10(parseFloat(value)))
  display = crdb_humanFormat(key, value)
  b = d3.interpolateReds(magnitude / 10)
  c = "black"
  if ((magnitude / 12) > 0.9) {
    c = "white"
  }
  wrapper = container.append("g")
  wrapper.append("rect")
    .attr("x", rect.x - crdb_CONFIG.dag.nodeRadius - 2)
    .attr("y", rect.y + yoffset)
    .attr("rx", r)
    .attr("fill", b)
    .attr("width", width)
    .attr("height", height)
  wrapper.append("text")
    .attr("font-size", "0.25em")
    .attr("x", rect.x - crdb_CONFIG.dag.nodeRadius - 1)
    .attr("y", rect.y + ytextoffset)
    .attr("fill", c)
    .attr("height", height).text(name + ": " + display)
}

function crdb_displayHorizontalLine(container, rect) {
  container.append("line")
    .attr("x1", - crdb_CONFIG.dag.nodeRadius)
    .attr("x2", crdb_CONFIG.dag.nodeRadius)
    .attr("y1", rect.y + 14)
    .attr("y2", rect.y + 14)
    .attr("stroke", "gray")
    .attr("stroke-width", "0.01%")
}

function crdb_displayText(container, rect, name, value) {
  const r = 2;
  let v = name;
  if (value != "") v += ": " + value
  v = crdb_trimText(v, 60)
  wrapper = container.append("g")
  wrapper.append("text")
    .attr("font-size", "0.25em")
    .attr("x", rect.x)
    .attr("y", rect.y + 14)
    .attr("text-anchor", rect.anchor)
    .attr("height", 5).text(v)
}

function crdb_extractMetrics(details) {
  var res = []
  details.forEach(e => {
    if (e.includes("Out:")) {
      res["cols output"] = e.split(",").length
    } else if (e.includes(":")) {
      t = e.split(":")
      res[t[0].trim()] = crdb_normalizeUnits(t[1].trim())
    }
  }
  )
  return res
}

function crdb_displayDetails(core) {
  x = 6
  width = 10
  metrics = crdb_extractMetrics(core.details)
  var container = d3.create("svg:g").attr("width", 100)
  var i = 0;
  var padding = 1

  for (const group in crdb_METRICS) {
    j = 0
    for (const metric in crdb_METRICS[group]) {
      ry = i * 7
      rx = j * 30
      k = crdb_METRICS[group][metric]
      value = metrics[k]
      if (value != null) {
        if (j == 0 && group != "main") {
          crdb_displayText(container, { x: crdb_CONFIG.dag.nodeDim.x + 5, y: ry, anchor: "start" }, group + ":", "")
        }
        crdb_displayMetric(container, { x: rx, y: ry }, metric, k, value)
        j++
      }
    }
    if (j > 0) i++
  }
  if (i > 0) {
    crdb_displayHorizontalLine(container, { y: i * 6 })
    i++
  }
  for (d in core.details) {
    detail = core.details[d]
    if (detail.startsWith("Out:") || detail.startsWith("execution time:")) break;
    if (i >= crdb_CONFIG.dag.maxRows) break
    t = detail.split(": ")
    var key, value;
    key = t[0]
    value = t.slice(1).join(" ")
    crdb_displayText(container, { x: 0, y: i * 6, anchor: "middle" }, key, value)
    i++
  }
  return container.node()
}

function crdb_graphView(wrapper, tooltip) {
  var data = crdb_DATA
  var svg = crdb_newDagContainer(wrapper)
    .attr("width", crdb_CONFIG.dim.width)
    .attr("height", crdb_CONFIG.dim.height);
  var res = []
  var edgeInfo = []
  data.edges.forEach(element => {
    res.push([String(element.destProc), String(element.sourceProc)])
    edgeInfo[String(element.sourceProc) + "-" + String(element.destProc)] = element
  });
  dag = d3.dagConnect()(res)
  var ops = new Set()
  data.processors.forEach(n => {
    ops.add(String(n.core.title.split("/")[0].replaceAll(" ", "_")))
  });
  const nodeRadius = crdb_CONFIG.dag.nodeRadius;
  const layout = d3
    .sugiyama()
    .nodeSize((node) => [(node ? 3.6 : 0.25) * nodeRadius, 3 * nodeRadius]); // set node size instead of constraining to fit
  const { width, height } = layout(dag);
  svgSelection = crdb_zoom(svg, width, height)
  crdb_drawEdges(svgSelection, height, dag.links(), edgeInfo)
  crdb_drawNodes(svgSelection, height, dag, data)
}

// Table View
function crdb_cell(el, value, col, infoCols, metricCols) {
  columns = infoCols.concat(metricCols)
  data = crdb_DATA
  if (col == 0) {
    td = d3.select(el).append("td").text(value)
      .on("click", function (event, d) {
        id = "id_" + value

        selector = "#" + id
        node = d3.selectAll(selector)
        crdb_debug("cell", crdb_SELECTED.size + ": " + id + " " + crdb_IDS.indexOf(id) + ":" + node)
        if (crdb_SELECTED.has(value)) {
          crdb_SELECTED.delete(value)
          switch (node.node().tagName) {
            case 'rect': node.attr("fill", "#FFFFFF"); break;
            case 'path': node.attr("stroke", "gray").attr("stroke-width", "0.01%"); break;
          }
          d3.select(this).style("background-color", null)
        } else {
          crdb_SELECTED.add(value)
          a = d3.interpolateRainbow(crdb_IDS.indexOf(id) / crdb_IDS.length)
          switch (node.node().tagName) {
            case 'rect': node.attr("fill", a); break;
            case 'path': node.attr("stroke", a).attr("stroke-width", "0.1%"); break;
          }
          d3.select(this).style("background-color", a)
        }
      })
    if (crdb_SELECTED.has(value)) {
      id = "id_" + value
      a = d3.interpolateRainbow(crdb_IDS.indexOf(id) / crdb_IDS.length)
      td.style("background-color", a)
    }
  } else if (col >= infoCols.length && typeof value === "number" && value > 0) {
    s = crdb_humanFormat(columns[col], value)
    m = Math.round(Math.log10(parseFloat(value)))
    b = d3.interpolateReds(m / 12)
    c = "black"
    if ((m / 12) > 0.9) {
      c = "white"
    }
    d3.select(el).append("td").style("background-color", b).style("color", c).text(s)
  } else {
    d3.select(el).append("td").text(value)
  }
}

function crdb_cellValue(details, prefix) {
  r = details.filter(e => e.startsWith(prefix))[0]
  if (r != null) {
    r = crdb_normalizeUnits(r.replace(prefix, ""))
    return r
  }
  return " "
}

function crdb_columnHeader(div, colSortName, dir, refreshFun) {
  div.append("span")
    .append("i").attr("class",
      (d) => {
        if (colSortName === d && dir == 1) return "fa fa-caret-down"
        if (colSortName === d && dir == -1) return "fa fa-caret-up"
        return "fa"
      })
  div.append("span")
    .text(d => d)
  div.on("click", function (event, d) {
    if (colSortName == d) dir = -dir
    else dir = 1
    refreshFun(d, dir)
  })
}

function crdb_displayTable(table, infoCols, metricCols, rows, refreshFun, colSortName, dir) {
  colSort = infoCols.concat(metricCols).indexOf(colSortName)
  var rows = rows.sort(function (a, b) {
    if (a[colSort] < b[colSort]) return dir;
    if (a[colSort] > b[colSort]) return -dir;
    return 0;
  });
  d3.select(table).html("")
  t = d3.select(table).append("table").attr("class", "details")
  h = t.append("thead")
  div = h.selectAll("tr")
    .data(infoCols)
    .enter()
    .append("th")
    .append("div")
  crdb_columnHeader(div, colSortName, dir, refreshFun)
  div = h.selectAll("tr")
    .data(metricCols)
    .enter()
    .append("th")
    .append("div").attr("class", "slanted")
  crdb_columnHeader(div, colSortName, dir, refreshFun)
  t = t.append("tbody")
  t.selectAll("tr")
    .data(rows)
    .enter()
    .append("tr")
    .each(function (d) { d.forEach((v, i) => crdb_cell(this, v, i, infoCols, metrics)) })
}

function crdb_displayEdgeStatsAsTable(table, data, colSortName, dir) {
  infoCols = ["Id", "Input", "Output"]
  metrics = ['network latency', 'network wait time', 'deserialization time', 'network rows received',
    'network bytes received', 'network messages received',
    'max memory allocated', 'max sql temp disk usage',
    'batches output', 'rows output']
  rows = []
  edges = data.edges.filter(d => d.stats)
  if (edges != null & edges.length > 0) {
    edges.forEach((d, i) => {
      row = [
        d.sourceProc + "-" + d.destProc,
        data.nodeNames[data.processors[d.sourceProc].nodeIdx],
        data.nodeNames[data.processors[d.destProc].nodeIdx]
      ]
      metrics.forEach(m => row.push(crdb_cellValue(d.stats, m + ":")))
      rows.push(row)
    })
    crdb_displayTable(table, infoCols, metrics, rows,
      function f(d, direction) {
        crdb_displayEdgeStatsAsTable(table, data, d, direction)
      }, colSortName, dir)
  }
}

function crdb_displayProcessorStatsAsTable(table, data, colSortName, dir) {
  infoCols = ["Id", "Node", "Level", "Processor", "Synchs", "Routers"]
  metrics = ["execution time",
    "input rows", "rows output", "batches output",
    "KV time", "KV contention time", "KV rows read", "KV bytes read",
    "max memory allocated", "max scratch disk allocated"
  ]
  rows = []
  maxLevel = 0
  data.processors.forEach((d, i) => {
    if (d.stage > maxLevel) maxLevel = d.stage
  })
  data.processors.forEach((d, i) => {
    level = maxLevel - d.stage + 1
    if (d.core.title === "Response") level = 0
    row = [
      i,
      data.nodeNames[d.nodeIdx],
      level,
      d.core.title,
      d.inputs.length,
      d.outputs.length
    ]
    metrics.forEach(m => row.push(crdb_cellValue(d.core.details, m + ":")))
    rows.push(row)
  })
  crdb_displayTable(table, infoCols, metrics, rows,
    function f(d, direction) {
      crdb_displayProcessorStatsAsTable(table, data, d, direction)
    }, colSortName, dir)
}

function crdb_tableView(div) {
  crdb_displayProcessorStatsAsTable(div + "_processors", crdb_DATA, "Level", 1)
  crdb_displayEdgeStatsAsTable(div + "_edges", crdb_DATA, "network latency", 1)
}

// SQL View
function crdb_sqlView(sql) {
  d3.select(sql).html("")
  d3.select(sql).append("pre").text(sqlFormatter.format(crdb_DATA.sql))
}

// Edge highlight
function crdb_edgeEvents(element, info) {
  if (info) element
    .on("mouseover", function (event, d) {
      element.style("stroke", "gray")
      crdb_tooltipShow(event, info);
    })
    .on("mouseout", function (event, d) {
      element.style("stroke", "transparent")
      crdb_tooltipHide(event);
    });
}

// Tooltips 
function crdb_tooltipEvents(element, info) {
  if (info.length > 0) element
    .on("mouseover", function (event, d) {
      element.style("fill", "gray")
      crdb_tooltipShow(event, info);
    })
    .on("mouseout", function (event, d) {
      element.style("fill", "#DDDDDD")
      crdb_tooltipHide(event);
    });
}

function crdb_tooltipShow(event, info) {
  var tooltip = d3.select("#tooltip")
  tooltip.html("")
  tb = tooltip.append("table").attr("class", "details")
  pre = ""
  lines = 0
  info.forEach((k) => {
    lines++
    t = k.split(": ")
    tr = tb.append("tr")
    if (t.length >= 2) {
      tr.append("td").text(t[0]).style("width", "100px")
      v = t.slice(1).join(" ")
      if (t[0] === "Out") v = crdb_trimText(v, 100)
      tr.append("td").text(v).style("width", "400px")
    } else {
      tr.append("td").text(" ")
      v = t[0]
      tr.append("td").text(v).style("width", "400px")
    }
  })
  var boundaries = d3.select("body").node().getBoundingClientRect()
  var x = Math.min(event.pageX + 50, boundaries.right - 100)
  var y = Math.min(event.pageY - 50, Math.max(boundaries.top, boundaries.bottom - (lines * 20)))
  tooltip.style("left", x + "px")
    .style("top", y + "px")
    .style("opacity", 50)
}

function crdb_tooltipHide(event) {
  var tooltip = d3.select("#tooltip");
  tooltip.style("opacity", 0);
}

// Toggle Views
function crdb_view(id) {
  d3.selectAll(".w3-bar-item").style("color", "white")
  d3.selectAll(".view").style("display", "none")
  d3.select(id + "_button").style("color", "#6933ff")
  d3.select(id).style("display", "block")
}

function crdb_init(wrapper, tooltip, table, sql, plan, redirect) {
  crdb_DATA = crdb_getData()
  d3.select(plan).style("height", (crdb_CONFIG.dim.height - 200) + "px")
  d3.select(plan).style("width", (crdb_CONFIG.dim.width - 200) + "px")
  if (crdb_DATA == null) {
    crdb_view('#plan_view')
  } else {
    d3.select(redirect).style("display", "block")
    crdb_debug("init", crdb_DATA)
    d3.select(plan).node().value = JSON.stringify(crdb_DATA, null, 2)
    crdb_graphView(wrapper, tooltip)
    crdb_tableView(table)
    crdb_sqlView(sql)
    crdb_view('#table_view')
  }
}

function crdb_refresh(wrapper, tooltip, table, sql, plan) {
  crdb_DATA = null;
  crdb_SELECTED = new Set()
  crdb_IDS = []
  crdb_DATA = JSON.parse(d3.select(plan).node().value);
  crdb_debug("init", crdb_DATA)
  crdb_graphView(wrapper, tooltip)
  crdb_tableView(table)
  crdb_sqlView(sql)
  crdb_view('#table_view')
}

function crdb_redirect() {
  window.open("https://cockroachdb.github.io/distsqlplan/decode.html" + window.location.hash, "_self")
}
