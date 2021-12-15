
// Copyright 2021 The Cockroach Authors.
//
// Use of this software is governed
// by the Apache License, Version 2.0, included in the file
// LICENSE
const crdb_CONFIG = {
  margin: { top: 20, right: 20, bottom: 20, left: 20 },
  dim: { width: window.innerWidth, height: window.innerHeight },
  cost: { width: 20, height: 20 }
}

var crdb_DATA = null;
var crdb_SELECTED = new Set()
var crdb_IDS = []
var crdb_DEBUG_LABELS = new Set(); //["init"]

// Utility functions
function crdb_debug (label, msg) {
   if (crdb_DEBUG_LABELS.has(label) ) {
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
  if (v.endsWith("s")) return parseFloat(v) * 1000 * 1000


  if (v.endsWith("KiB")) return parseInt(parseFloat(v) * 1024)
  if (v.endsWith("MiB")) return parseInt(parseFloat(v) * 1024 * 1024)
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

  var scale = Math.min(Math.min(scaleX, scaleY), 5);

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
      .attr("d", ({ source, points }) => {
        points[0].y = points[0].y + 10
        points[1].y = points[1].y - 60
        return line(points)
      })
      .attr("class", "edge")
      .attr("stroke", "gray")
      .attr("stroke-width", "0.01%")
      .attr("id", (d) =>  {
          f=d.data[1]
          t=d.data[0] 
          crdb_IDS.push("id_" + f + "-" +t)
          return "id_" + f + "-" +t
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
    .attr("stroke-width", "0.5%")
    .each( function (d) {
      crdb_edgeEvents (d3.select(this),linksInfo[d.data[1] + "-" +d.data[0]])
     
    })
  }


function crdb_drawBox(nodes,data) {
  nodes
    .append("rect")
    .attr("id", (d,i) => {
      crdb_IDS.push("id_"+ d.data.id) 
      return "id_" + d.data.id })
    .attr("rx", 15)
    .attr("height", 70)
    .attr("width", 100)
    .attr("x", -50)
    .attr("y", -10)
    .attr("stroke-width", "1px")
    .attr("fill-opacity", .50)
    .attr("stroke", "#DDDDDD")
    .attr("fill", "#FFFFFF")
    
}

// TODO clean up...

function crdb_drawBoxHeader(nodes, data) {
  
  nodes
    .filter((d) => (data.processors[parseInt(d.data.id)]
                    .inputs.filter (e => e.title === "ordered").length > 0))
    .append("circle")
    .attr("r", 5)
    .attr("cx", 0)
    .attr("cy", -10)
    .attr("fill-opacity", 1)
    .attr("fill", "blue")
    nodes
    .filter((d) => (data.processors[parseInt(d.data.id)]
                    .inputs.filter (e => e.title === "ordered").length > 0))
    .append("text")
    .text("O")
    .attr("r", 5)
    .attr("x", 0)
    .attr("y", -9)
    .attr("font-size", "0.5em")
    .attr("font-weight", "bold")
    .attr("text-anchor", "middle")
    .attr("alignment-baseline", "middle")
    .attr("fill", "white")  

  nodes
    .filter((d) => (data.processors[parseInt(d.data.id)]
                    .inputs.filter (e => e.title === "unordered").length > 0))
    .append("circle")
    .attr("r", 5)
    .attr("cx", 0)
    .attr("cy", -10)
    .attr("fill-opacity", 1)
    .attr("fill", "blue") 
   nodes
    .filter((d) => (data.processors[parseInt(d.data.id)]
                    .inputs.filter (e => e.title === "unordered").length > 0))
    .append("text")
    .text("U")
    .attr("r", 5)
    .attr("x", 0)
    .attr("y", -9)
    .attr("font-size", "0.5em")
    .attr("font-weight", "bold")
    .attr("text-anchor", "middle")
    .attr("alignment-baseline", "middle")
    .attr("fill", "white")   

    nodes
    .filter((d) => (data.processors[parseInt(d.data.id)].outputs.length > 0))
    .append("circle")
    .attr("r", 5)
    .attr("cx", 0)
    .attr("cy", 60)
    .attr("fill-opacity", 1)
    .attr("fill", "orange")

    nodes
    .filter((d) =>  (data.processors[parseInt(d.data.id)].outputs.length > 0))
    .append("text")
    .text("H")
    .attr("r", 5)
    .attr("x", 0)
    .attr("y", 61)
    .attr("font-size", "0.5em")
    .attr("font-weight", "bold")
    .attr("text-anchor", "middle")
    .attr("alignment-baseline", "middle")
    .attr("fill", "white")
  
    nodes
    .append("text")
    .text((d, i) => {
      return   "Node#" +
        data.nodeNames[data.processors[parseInt(d.data.id)].nodeIdx]
    })
    .attr("font-size", "0.25em")
    .attr("font-family", "sans-serif")
    .attr("x", -30)
    .attr("text-anchor", "middle")
    .attr("alignment-baseline", "middle")
    .attr("fill", "black");

  nodes
    .append("text")
    .text((d) => {
      return data.processors[parseInt(d.data.id)].core.title
    })
    .attr("font-size", "0.25em")
    .attr("font-family", "sans-serif")
    .attr("x", 20)
    .attr("text-anchor", "middle")
    .attr("alignment-baseline", "middle")
    .attr("fill", "black");

  nodes
    .append("rect")
    .attr("name", (d) => ('node_' + data.nodeNames[data.processors[parseInt(d.data.id)].nodeIdx]))
    .attr("rx", 10)
    .attr("height", 10)
    .attr("width", 45)
    .attr("x", -45)
    .attr("y", -5)
    .attr("fill-opacity", .40)
    .attr("fill", "#DDDDDD")
    .on("click", function (event, d) { 
        s= "[name~=" + d3.select(this).attr("name") +"]"
        a = d3.select(this).attr("fill")
        if (a === "#DDDDDD") {
           d3.selectAll(s).attr("fill", d3.interpolateRainbow(Math.random()))}
        else {
           d3.selectAll(s).attr("fill", "#DDDDDD")
        }   
      }
        )

  nodes
    .append("rect")
    .attr("name", (d) => ('ops_' + data.processors[parseInt(d.data.id)].core.title.split('/')[0].replaceAll(" ", "_")))
    .attr("rx", 10)
    .attr("height", 10)
    .attr("width", 45)
    .attr("x", 0)
    .attr("y", -5)
    .attr("fill-opacity", .40)
    .attr("fill", "#DDDDDD")
    .each( function (d) {
      crdb_tooltipEvents (d3.select(this),data.processors[parseInt(d.data.id)].core.details)}
      )

 
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


  crdb_drawBox(nodes,data)
  crdb_drawBoxHeader(nodes, data)

  // Metrics

  nodes
    .append((d) => {
      details = data.processors[parseInt(d.data.id)].core.details
      return crdb_displayMetrics(crdb_parseDetails(details))
    }
    )
}



function crdb_parseDetails(details) {
  var res = []
  details.forEach(e => {
    if (e.includes(":")) {
      t = e.split(":")
      res[t[0].trim()] = [crdb_normalizeUnits(t[1].trim()),t[1]]
    } 
    // else if (e.includes("=")) {
    //   res["join"] = e
    // } else if (e.match(/\w@\w/)) {
    //   res["index"] = e
    // }
  }
  )
  return res
}

// TODO: remove hardcoded values

function crdb_displayMetric(container, rect, name, value, orig) {
  const r = 2;
  magnitude = Math.round(Math.log10(parseFloat(value)))
  color = d3.interpolateReds(magnitude / 10)
  wrapper = container.append("g")
  wrapper.append("rect")
    .attr("x", rect.x - 50)
    .attr("y", rect.y + 10)
    .attr("rx", r)
    .attr("fill", color)
    .attr("width", 5)
    .attr("height", 5)
  wrapper.append("text")
    .attr("font-size", "0.25em")
    .attr("x", rect.x - 50 + 6)
    .attr("y", rect.y + 10 + 3)
    .attr("width", rect.width)
    .attr("height", 5).text(metric + ": " + orig)
}

function crdb_displayText(container, rect, name, value) {
  const r = 2;
  wrapper = container.append("g")
  wrapper.append("text")
    .attr("font-size", "0.25em")
    .attr("x", rect.x - 50 + 6)
    .attr("y", rect.y + 10 + 3)
    .attr("width", rect.width)
    .attr("height", 5).text(metric + ": " + value)
}

function crdb_displayMetrics(metrics) {
  var container = d3.create("svg:g").attr("width", 100)
  var i = 0;
  var padding = 1
  for (metric in metrics) {
    v = metrics[metric]
    crdb_debug("displayMetrics", metric + ":" +v)
    if (typeof v[0] === "number" & v[0] > 0) {
      rx = 6
      ry = i * 6
      width = 10
      crdb_displayMetric(container, { x: rx, y: ry, width: width }, metric, v[0],v[1])
      i++
    } 
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
    edgeInfo[String(element.sourceProc) + "-" + String(element.destProc)] = element.stats
  });
  dag = d3.dagConnect()(res) 
  var ops = new Set()
  data.processors.forEach(n => {
    ops.add(String(n.core.title.split("/")[0].replaceAll(" ", "_")))
  });
  const nodeRadius = 40;
  const layout = d3
    .sugiyama()
    .nodeSize((node) => [(node ? 3.6 : 0.25) * nodeRadius, 3 * nodeRadius]); // set node size instead of constraining to fit
  const { width, height } = layout(dag);
  svgSelection = crdb_zoom(svg, width, height)
  crdb_drawEdges(svgSelection, height, dag.links(), edgeInfo)
  crdb_drawNodes(svgSelection, height, dag, data)
}


// Table View

function crdb_cell(el, value, col, types) {
  data = crdb_DATA
  
  if (col == 0 ) {
    td = d3.select(el).append("td").text(value)
    .on("click", function (event, d) {
      id = "id_" + value
      
      selector = "#" + id
      node = d3.selectAll(selector)
      crdb_debug("cell" , crdb_SELECTED.size + ": " + id + " " + crdb_IDS.indexOf(id) + ":" + node)

      if (crdb_SELECTED.has(value)) {
        crdb_SELECTED.delete(value)
        switch( node.node().tagName) { 
          case 'rect':  node.attr("fill", "#FFFFFF") ; break;
          case 'path':  node.attr("stroke", "gray").attr("stroke-width", "0.01%") ; break;
        }
        d3.select(this).style("background-color", null)
      } else {
        crdb_SELECTED.add(value)
        a = d3.interpolateRainbow(crdb_IDS.indexOf(id)/crdb_IDS.length)
        switch( node.node().tagName) { 
          case 'rect':  node.attr("fill", a) ; break;
          case 'path':  node.attr("stroke", a).attr("stroke-width", "0.1%") ; break;
        }
        d3.select(this).style("background-color", a)
      }
      
    })
    if (crdb_SELECTED.has(value)) {
      id = "id_" + value
      a = d3.interpolateRainbow(crdb_IDS.indexOf(id)/crdb_IDS.length)
      td.style("background-color", a)
    }
  } else if (col > 3 && typeof value === "number" && value > 0) {
    if (types[col] === "bytes") {
     s = HRNumbers.toHumanString(value) +"B"
    } else if (types[col] === "time") {
      if (value >= 1000000) {
        s=(value / 1000000).toFixed(1) + "s"
      } else if (value >= 1000) {
        s=(value / 1000).toFixed(0) + "ms"
      } else {
        s=value + "µs"
      }
     } else {
      s = HRNumbers.toHumanString(value)
     }
    m = Math.round(Math.log10(parseFloat(value)))
    c = d3.interpolateReds(m / 12)
    d3.select(el).append("td").style("background-color", c).text(s) 
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

function crdb_displayEdgeStatsAsTable(table, data, colSortName) {

  infoCols = ["Id", "Input","Output"]
  rows = []
  metrics = ['network latency', 'network wait time', 'deserialization time', 'network rows received', 
              'network bytes received', 'network messages received',
              'max memory allocated', 'max sql temp disk usage',
               'batches output', 'rows output']
  types = ["num","num","num", 
           "time", "time", "time" ,"num",
           "bytes","num",
           "bytes","bytes",
           "num","num"]            
 
  edges = data.edges.filter (d => d.stats)
  if (edges != null & edges.length > 0) {            
    edges.forEach((d,i) => {
      row = [
        d.sourceProc + "-" + d.destProc,
        data.nodeNames[data.processors[d.sourceProc].nodeIdx],
        data.nodeNames[data.processors[d.destProc].nodeIdx]
        
      ]
      metrics.forEach(m => row.push(crdb_cellValue(d.stats, m + ":")))
      rows.push(row)
    }
    )

    colSort = infoCols.concat(metrics).indexOf(colSortName)
    if (colSort == 1) dir = -1
    else dir = 1
    var rows = rows.sort(function (a, b) {
      if (a[colSort] < b[colSort]) return dir;
      if (a[colSort] > b[colSort]) return -dir;
      return 0;
    });
    
    d3.select(table).html("")

    t = d3.select(table).append("table").attr("class", "details")
    h = t.append("thead")
    h.selectAll("tr")
      .data(infoCols)
      .enter()
      .append("th")
      .text(d => d)
      .on("click", function (event, d) { crdb_displayEdgeStatsAsTable(table, data, d) })
    h.selectAll("tr")
      .data(metrics)
      .enter()
      .append("th")
      .append("div")
      .append("span")
      .text(d => d)
      .on("click", function (event, d) { crdb_displayEdgeStatsAsTable(table, data, d) })
    t = t.append("tbody")
    t.selectAll("tr")
      .data(rows)
      .enter()
      .append("tr")
      .each(function (d) {  d.forEach( (v,i) => crdb_cell(this, v, i,types)) }) 
  }
}



function crdb_displayProcessorStatsAsTable(table, data, colSortName) {

  metrics = ["execution time",
    "input rows", "rows output", "batches output",
    "KV time", "KV contention time", "KV rows read", "KV bytes read",
    "max memory allocated", "max scratch disk allocated"
  ]

  infoCols = ["Id", "Node","Processor", "Synchs", "Routers"]
  processors = []
  types = ["num","num","num", "num", "num",
          "time", 
           "num","num", "num",
          "time", "time", "num", "bytes",
          "bytes", "bytes" ]  

  data.processors.forEach((d,i) => {
    row = [
      i,
      data.nodeNames[d.nodeIdx],
      d.core.title,
      d.inputs.length,
      d.outputs.length
    ]
    metrics.forEach(m => row.push(crdb_cellValue(d.core.details, m + ":")))
    processors.push(row)
  }
  )

  colSort = infoCols.concat(metrics).indexOf(colSortName)
  if (colSort == 1) dir = -1
  else dir = 1
  var processors = processors.sort(function (a, b) {
    if (a[colSort] < b[colSort]) return dir;
    if (a[colSort] > b[colSort]) return -dir;
    return 0;
  });
  
  d3.select(table).html("")

  t = d3.select(table).append("table").attr("class", "details")
  h = t.append("thead")
  h.selectAll("tr")
    .data(infoCols)
    .enter()
    .append("th")
    .text(d => d)
    .on("click", function (event, d) { crdb_displayProcessorStatsAsTable(table, data, d) })

  h.selectAll("tr")
    .data(metrics)
    .enter()
    .append("th")
    .append("div")
    .append("span")
    .text(d => d)
    .on("click", function (event, d) { crdb_displayProcessorStatsAsTable(table, data, d) })
  t = t.append("tbody")
  t.selectAll("tr")
    .data(processors)
    .enter()
    .append("tr")
    .each(function (d) {  d.forEach( (v,i) => crdb_cell(this, v,i,types)) })

}



function crdb_tableView(div) {
  crdb_displayProcessorStatsAsTable(div + "_processors", crdb_DATA, "execution time")
  crdb_displayEdgeStatsAsTable(div + "_edges", crdb_DATA, "network latency")
}

// SQL View
function crdb_sqlView(sql) {
  d3.select(sql).html("")
  d3.select(sql).append("pre").text(sqlFormatter.format(crdb_DATA.sql))
}

// Edge highlight

function crdb_edgeEvents(element, info) {
  if (info) element
      .on("mouseover", function(event, d) {	
          element.style("stroke", "gray")
          crdb_tooltipShow(event,info);
      })
      .on("mouseout", function(event, d) {	
         element.style("stroke", "transparent")
         crdb_tooltipHide(event);
      });
}

// Tooltips 

function crdb_tooltipEvents(element, info) {
  if (info) element
      .on("mouseover", function(event, d) {	
          crdb_tooltipShow(event,info);
      })
      .on("mouseout", function(event, d) {	
          crdb_tooltipHide(event);
      });
}




function crdb_tooltipShow(event, info) {
  var boundaries = d3.select("body").node().getBoundingClientRect()

  var x = Math.min (event.pageX + 50, boundaries.right-100)
  var y = Math.min (event.pageY - 50, boundaries.bottom-50)
  
  var tooltip = d3.select("#tooltip")
      .style("left", x + "px")
      .style("top", y + "px")

  tooltip.html("").style("opacity", 50)
  tb = tooltip.append("table").attr("class","tooltip")
  
  pre = ""
  info.forEach( (k) => {
    t = k.split(": ")
    tr=tb.append("tr")
    if (t.length >= 2) {
      tr.append("td").text(t[0]).style("width","100px")
      tr.append("td").text(t.slice(1).join(" ")).style("width","400px")
    } else {
      tr.append("td").text(" ")
      tr.append("td").text(t[0]).style("width","400px")
    }
  }
  )
  //tooltip.append("pre").text(JSON.stringify(info, crdb_null, 2))
  
  
}

function crdb_tooltipHide(event) {
  var tooltip = d3.select("#tooltip");
  tooltip.transition()
      .duration(1000)		
      .style("opacity", 0);
}

// Toggle Views
function crdb_view(id) {
  d3.selectAll(".w3-bar-item").style("color", "white")
  d3.selectAll(".view").style("display", "none")
  d3.select(id +"_button").style("color", "#6933ff")
  d3.select(id).style("display", "block")
}



function crdb_init(wrapper, tooltip, table, sql, plan) {
  crdb_DATA = crdb_getData()
  d3.select(plan).style("height", (crdb_CONFIG.dim.height - 200) +"px")
  d3.select(plan).style("width",  (crdb_CONFIG.dim.width  - 200) +"px")
  if (crdb_DATA == null) {
    crdb_view('#plan_view')
  } else {
    crdb_debug("init", crdb_DATA)
    d3.select(plan).node().value = JSON.stringify(crdb_DATA,null, 2)
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


