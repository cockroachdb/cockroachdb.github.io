var width = window.innerWidth,
    height = window.innerHeight;

if (width > 60) {
  width = width - 60;
}
if (height > 50) {
  height = height - 50;
}

var d3cola = cola.d3adaptor()
  //.linkDistance(function(link) { return link.distance })
  .jaccardLinkLengths(40,0.7)
  .avoidOverlaps(true)
  .flowLayout("y", 80)
  .size([width, height]);

var outer = d3.select("body").append("svg")
  .attr("width", width)
  .attr("height", height)
  .attr("pointer-events", "all");

outer.append("rect")
  .attr("class", "background")
  .attr("width", "100%")
  .attr("height", "100%")
  .call(d3.behavior.zoom().on("zoom", redraw));

var vis = outer
  .append("g")
  .attr("transform", "translate(80,80) scale(0.7)");

function redraw() {
  vis.attr("transform", "translate(" + d3.event.translate + ")" + " scale(" + d3.event.scale + ")");
}

var groupsLayer = vis.append("g");
var nodesLayer = vis.append("g");
var linksLayer = vis.append("g");

var graph = {}, nodeLookup = {};

function init(data) {
  graph.nodes = [];
  for (var i = 0; i < data.processors.length; i++) {
    var p = data.processors[i];
    p.core.graphNodeIdx = graph.nodes.length
   
    graph.nodes.push({
      title: p.core.title,
      details: p.core.details,
      width: 60,
      height: 40,
      rx: 5,
      ry: 5,
      type: "core",
      stage: p.stage,
    });
    for (var j = 0; j < p.inputs.length; j++) {
      p.inputs[j].graphNodeIdx = graph.nodes.length
      graph.nodes.push({
        title: p.inputs[j].title,
        details: p.inputs[j].details,
        width: 60,
        height: 40,
        rx: 15,
        ry: 15,
        type: "synchronizer"
      });
    }
    for (var j = 0; j < p.outputs.length; j++) {
      p.outputs[j].graphNodeIdx = graph.nodes.length
      graph.nodes.push({
        title: p.outputs[j].title,
        details: p.outputs[j].details,
        width: 60,
        height: 40,
        rx: 15,
        ry: 15,
        type: "router"
      });
    }
  }

  graph.links = [];
  for (var i = 0; i < data.edges.length; i++) {
    var srcNode, destNode;

    var e = data.edges[i];
    var p1 = data.processors[e.sourceProc];
    var siblings = 1;
    if (e.sourceOutput) {
      srcNode = p1.outputs[e.sourceOutput-1].graphNodeIdx;
      var type = p1.outputs[e.sourceOutput-1].title;
      if (type === "by hash" || type === "by range") {
        for (var j = 0; j < data.edges.length; j++) {
          if (i != j && data.edges[j].sourceProc === e.sourceProc &&
              data.edges[j].sourceOutput === e.sourceOutput) {
            siblings = siblings + 1
          }
        }
      }
    } else {
      srcNode = p1.core.graphNodeIdx;
    }
    p2 = data.processors[e.destProc];
    if (e.destInput) {
      destNode = p2.inputs[e.destInput-1].graphNodeIdx;
    } else {
      destNode = p2.core.graphNodeIdx;
    }
    var width = 3.0 / siblings;
    if (width < 1) {
      width = 1
    }
    graph.links.push({source: srcNode, target: destNode, width: width});
  }

  // Generate groups.
  graph.groups = [];
  for (var i = 0; i < data.nodeNames.length; i++) {
    graph.groups.push({
      nodeID: data.nodeNames[i],
      leaves: [],
      padding:15
    });
  }
  for (var i = 0; i < data.processors.length; i++) {
    var p = data.processors[i];
    var n = p.nodeIdx;
    graph.groups[n].leaves.push(p.core.graphNodeIdx);
    for (var j = 0; j < p.inputs.length; j++) {
      graph.groups[n].leaves.push(p.inputs[j].graphNodeIdx);
    }
    for (var j = 0; j < p.outputs.length; j++) {
      graph.groups[n].leaves.push(p.outputs[j].graphNodeIdx);
    }
  }

  // Generate constraints to align input synchronizers and output
  // synchronizers next to the core.
  graph.constraints = [];
  for (var i = 0; i < data.processors.length; i++) {
    var p = data.processors[i];
    if (p.inputs.length === 0 && p.outputs.length === 0) {
      continue
    }
    var xConstr = {
      type: "alignment",
      axis: "x",
      offsets: [{node:p.core.graphNodeIdx, offset: 0}]
    };
    var yConstr = {
      type: "alignment",
      axis: "y",
      offsets: [{node:p.core.graphNodeIdx, offset: 0}]
    };
    var hSpacing = 80, vSpacing = 28 + 10 * graph.nodes[p.core.graphNodeIdx].details.length;
    for (var j = 0; j < p.inputs.length; j++) {
      var n = p.inputs[j].graphNodeIdx;
      xConstr.offsets.push({node: n, offset: hSpacing * (2*j+1-p.inputs.length)});
      yConstr.offsets.push({node: n, offset: -vSpacing});
      // These edges are not visible, but they help with the layout.
      graph.links.push({source: n, target: p.core.graphNodeIdx, invisible: true});
    }
    for (var j = 0; j < p.outputs.length; j++) {
      var n = p.outputs[j].graphNodeIdx;
      xConstr.offsets.push({node: n, offset: hSpacing * (2*j+1-p.outputs.length)});
      yConstr.offsets.push({node: n, offset: +vSpacing});
      // These edges are not visible, but they help with the layout.
      graph.links.push({source: p.core.graphNodeIdx, target:n, invisible: true});
    }
    graph.constraints.push(xConstr, yConstr)
  }

  var color = d3.scale.category20();

  d3cola
    .nodes(graph.nodes)
    .links(graph.links)
    .groups(graph.groups)
    .constraints(graph.constraints)
    .start(10, 10, 10);

  // define arrow markers for graph links
  outer
    .append("svg:defs")
    .append("svg:marker")
      .attr("id", "end-arrow")
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 5)
      .attr("markerWidth", 3)
      .attr("markerHeight", 3)
      .attr("orient", "auto")
    .append("svg:path")
      .attr("d", "M0,-5L10,0L0,5L2,0")
      .attr("stroke-width", "0px")
      .attr("fill", "#000");

  var group = groupsLayer.selectAll(".group")
    .data(graph.groups)
    .enter()
      .append("rect")
        .attr("rx", 4).attr("ry", 4)
        .attr("class", "group")
        .style("fill-opacity", 0.2)
        .style("fill", function (d) { return color(d.nodeID) })
        .call(d3cola.drag);

  var link = linksLayer.selectAll(".link")
    .data(graph.links.filter(function(d) { return !d.invisible } ))
    .enter()
      .append("line")
        .attr("class", "link")
        .style("stroke-width", function(d) { return d.width } );

  var margin = 10, pad = 12;
  var node = nodesLayer.selectAll(".node")
    .data(graph.nodes)
      .enter().append("rect")
        .attr("class", function (d) { return d.type })
        .attr("width", function (d) { return d.width + 2 * pad + 2 * margin; })
        .attr("height", function (d) { return d.height + 2 * pad + 2 * margin; })
        .attr("rx", function (d) { return d.rx; })
        .attr("ry", function (d) { return d.ry; })
        .attr("id", function (d) { return "stage" + d.stage; })
        .on("mouseover", function(d) {
          var s = d3.select(this);
          if (d.stage != null && d.stage != 0) {
            s = d3.selectAll("#stage" + d.stage);
          }
          s.style("fill", function(d) {
            if (d.type === "core") {
              return "#eedd22";
            }
            return "";
          })
        })
        .on("mouseout", function(d) {
          var s = d3.select(this);
          if (d.stage != null && d.stage != 0) {
            s = d3.selectAll("#stage" + d.stage);
          }
          s.style("fill", "");
        })
        .call(d3cola.drag);

  var label = nodesLayer.selectAll(".label")
    .data(graph.nodes)
    .enter()
    .append("text")
      .attr("class", "label")
      .call(d3cola.drag);

  var setLabels = function (d) {
    var el = d3.select(this);
    el.text("")
    var size = 0
    if (d.type === "core") {
      size = 4
    }

    el.append("tspan")
     .text(d.title)
     .attr("x", 0).attr("dy", 18+size)
     .attr("font-size", 14+size)
     .attr("font-weight", "bold");

    if (!d.details) {
      return
    }
    for (var i = 0; i < d.details.length; i++) {
      el.append("tspan")
        .text(d.details[i])
        .attr("x", 0).attr("dy", 16+size)
        .attr("font-size", 12+size);
    }
  };

  label.each(setLabels);

  var groupLabel = vis.selectAll(".groupLabel")
    .data(graph.groups)
    .enter().append("text")
      .attr("font-size", "15")
      .attr("cursor", "default")
      .attr("pointer-events", "none")
      .text(function (d) { return "Node " + d.nodeID });

  d3cola.on("tick", function () {
      node.each(function (d) {
        d.innerBounds = d.bounds.inflate(- margin);
      });
      link.each(function (d) {
        d.route = cola.vpsc.makeEdgeBetween(d.source.innerBounds, d.target.innerBounds, 1);
        if (isIE())  this.parentNode.insertBefore(this, this);
      });

      link.attr("x1", function (d) { return d.route.sourceIntersection.x; })
          .attr("y1", function (d) { return d.route.sourceIntersection.y; })
          .attr("x2", function (d) { return d.route.arrowStart.x; })
          .attr("y2", function (d) { return d.route.arrowStart.y; });

      label.each(function (d) {
        var b = this.getBBox();
        d.width = b.width + 4 * margin + 8;
        d.height = b.height + 2 * margin + 8;
      });

      node.attr("x", function (d) { return d.innerBounds.x; })
          .attr("y", function (d) { return d.innerBounds.y; })
          .attr("width", function (d) { return d.innerBounds.width(); })
          .attr("height", function (d) { return d.innerBounds.height(); });

      group.attr("x", function (d) { return d.bounds.x; })
           .attr("y", function (d) { return d.bounds.y; })
           .attr("width", function (d) { return d.bounds.width(); })
           .attr("height", function (d) { return d.bounds.height(); });


      groupLabel.data(group.data())
        .attr("x", function(d) { return d.bounds.x + 5})
        .attr("y", function(d) { return d.bounds.y + 15});

      label.attr("transform", function (d) {
        return "translate(" + d.x + margin + "," + (d.y + margin - d.height/2) + ")";
      });
  });
}

function isIE() {
  return ((navigator.appName == "Microsoft Internet Explorer") ||
          ((navigator.appName == "Netscape") &&
           (new RegExp("Trident/.*rv:([0-9]{1,}[\.0-9]{0,})").exec(navigator.userAgent) != null)));
}
