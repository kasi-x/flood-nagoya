# SQL queries

SQL queries for the flood-nagoya data pipeline live here. They are meant
to be loaded from Python with DuckDB:

```python
import duckdb

con = duckdb.connect("data/pipeline.duckdb")
con.execute(open("data/queries/example.sql").read())
```

Keep transformations that produce derived tables in `data/processed/` and
exploratory queries in this directory, so the boundary between raw inputs and
reusable analysis stays explicit.
