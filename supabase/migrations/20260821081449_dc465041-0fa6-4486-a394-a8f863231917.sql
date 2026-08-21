CREATE OR REPLACE FUNCTION public.app_exec_sql(q text, params text[] DEFAULT '{}')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, public
AS $fn$
DECLARE
  n int := coalesce(array_length(params, 1), 0);
  is_query boolean := q ~* '^\s*(select|with)\s';
  wrapped text := 'WITH __q AS (' || q || ') SELECT coalesce(jsonb_agg(to_jsonb(__q)), ''[]''::jsonb) FROM __q';
  rows jsonb := '[]'::jsonb;
  affected int := 0;
BEGIN
  IF is_query THEN
    CASE n
      WHEN 0 THEN EXECUTE wrapped INTO rows;
      WHEN 1 THEN EXECUTE wrapped INTO rows USING params[1];
      WHEN 2 THEN EXECUTE wrapped INTO rows USING params[1], params[2];
      WHEN 3 THEN EXECUTE wrapped INTO rows USING params[1], params[2], params[3];
      WHEN 4 THEN EXECUTE wrapped INTO rows USING params[1], params[2], params[3], params[4];
      WHEN 5 THEN EXECUTE wrapped INTO rows USING params[1], params[2], params[3], params[4], params[5];
      WHEN 6 THEN EXECUTE wrapped INTO rows USING params[1], params[2], params[3], params[4], params[5], params[6];
      WHEN 7 THEN EXECUTE wrapped INTO rows USING params[1], params[2], params[3], params[4], params[5], params[6], params[7];
      WHEN 8 THEN EXECUTE wrapped INTO rows USING params[1], params[2], params[3], params[4], params[5], params[6], params[7], params[8];
      WHEN 9 THEN EXECUTE wrapped INTO rows USING params[1], params[2], params[3], params[4], params[5], params[6], params[7], params[8], params[9];
      WHEN 10 THEN EXECUTE wrapped INTO rows USING params[1], params[2], params[3], params[4], params[5], params[6], params[7], params[8], params[9], params[10];
      WHEN 11 THEN EXECUTE wrapped INTO rows USING params[1], params[2], params[3], params[4], params[5], params[6], params[7], params[8], params[9], params[10], params[11];
      WHEN 12 THEN EXECUTE wrapped INTO rows USING params[1], params[2], params[3], params[4], params[5], params[6], params[7], params[8], params[9], params[10], params[11], params[12];
      ELSE RAISE EXCEPTION 'app_exec_sql supports at most 12 parameters (got %)', n;
    END CASE;
    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN jsonb_build_object('rows', coalesce(rows, '[]'::jsonb), 'rowCount', jsonb_array_length(coalesce(rows, '[]'::jsonb)));
  END IF;

  CASE n
    WHEN 0 THEN EXECUTE q;
    WHEN 1 THEN EXECUTE q USING params[1];
    WHEN 2 THEN EXECUTE q USING params[1], params[2];
    WHEN 3 THEN EXECUTE q USING params[1], params[2], params[3];
    WHEN 4 THEN EXECUTE q USING params[1], params[2], params[3], params[4];
    WHEN 5 THEN EXECUTE q USING params[1], params[2], params[3], params[4], params[5];
    WHEN 6 THEN EXECUTE q USING params[1], params[2], params[3], params[4], params[5], params[6];
    WHEN 7 THEN EXECUTE q USING params[1], params[2], params[3], params[4], params[5], params[6], params[7];
    WHEN 8 THEN EXECUTE q USING params[1], params[2], params[3], params[4], params[5], params[6], params[7], params[8];
    WHEN 9 THEN EXECUTE q USING params[1], params[2], params[3], params[4], params[5], params[6], params[7], params[8], params[9];
    WHEN 10 THEN EXECUTE q USING params[1], params[2], params[3], params[4], params[5], params[6], params[7], params[8], params[9], params[10];
    WHEN 11 THEN EXECUTE q USING params[1], params[2], params[3], params[4], params[5], params[6], params[7], params[8], params[9], params[10], params[11];
    WHEN 12 THEN EXECUTE q USING params[1], params[2], params[3], params[4], params[5], params[6], params[7], params[8], params[9], params[10], params[11], params[12];
    ELSE RAISE EXCEPTION 'app_exec_sql supports at most 12 parameters (got %)', n;
  END CASE;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN jsonb_build_object('rows', '[]'::jsonb, 'rowCount', affected);
END;
$fn$;

REVOKE ALL ON FUNCTION public.app_exec_sql(text, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_exec_sql(text, text[]) FROM anon;
REVOKE ALL ON FUNCTION public.app_exec_sql(text, text[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.app_exec_sql(text, text[]) TO service_role;