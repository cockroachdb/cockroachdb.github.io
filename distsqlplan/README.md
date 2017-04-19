# Distributed SQL Plan Viewer

This directory contains two pages to view DistSQL plans:

* `index.html` contains a text box in which you can paste the JSON form of a
  DistSQL execution plan and see the associated visualization.
* `decode.html` visualizes a DistSQL plan. A URL deferencing this is provided
  by CockroachDB's `EXPLAIN (distsql)` SQL statement.
