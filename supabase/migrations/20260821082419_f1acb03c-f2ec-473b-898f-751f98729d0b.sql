CREATE OR REPLACE FUNCTION public.app_exec_sql(q text, params text[] DEFAULT '{}'::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app', 'public'
AS $function$
DECLARE
  n int := coalesce(array_length(params, 1), 0);
  is_query boolean := q ~* '^\s*(select|with)\s';
  stmt text := q;
  wrapped text;
  rows jsonb := '[]'::jsonb;
  affected int := 0;
  i int;
BEGIN
  -- Inline parameters as quoted literals (highest index first so $10 is not
  -- clobbered by $1). Literals are `unknown`-typed, so Postgres coerces them to
  -- each target column's type (timestamptz, int, jsonb) instead of failing on text.
  FOR i IN REVERSE n..1 LOOP
    stmt := regexp_replace(
      stmt,
      '\$' || i || '(?![0-9])',
      replace(quote_nullable(params[i]), '\', '\\'),
      'g'
    );
  END LOOP;

  IF is_query THEN
    wrapped := 'WITH __q AS (' || stmt || ') SELECT coalesce(jsonb_agg(to_jsonb(__q)), ''[]''::jsonb) FROM __q';
    EXECUTE wrapped INTO rows;
    RETURN jsonb_build_object(
      'rows', coalesce(rows, '[]'::jsonb),
      'rowCount', jsonb_array_length(coalesce(rows, '[]'::jsonb))
    );
  END IF;

  EXECUTE stmt;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN jsonb_build_object('rows', '[]'::jsonb, 'rowCount', affected);
END;
$function$;

REVOKE ALL ON FUNCTION public.app_exec_sql(text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_exec_sql(text, text[]) TO service_role;