-- Store each browser profile's current Game Stash sidebar membership. The raw
-- membership table stays private; the client can only read aggregate counts.
CREATE TABLE IF NOT EXISTS public.stash_sidebar_games (
    profile_id text NOT NULL,
    game_id text NOT NULL,
    title text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, game_id)
);

ALTER TABLE public.stash_sidebar_games ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.stash_sidebar_games FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.sync_stash_sidebar_games(
    p_profile_id text,
    p_games jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF p_profile_id IS NULL OR btrim(p_profile_id) = '' THEN
        RAISE EXCEPTION 'A profile ID is required.';
    END IF;
    IF jsonb_typeof(COALESCE(p_games, '[]'::jsonb)) <> 'array' THEN
        RAISE EXCEPTION 'The sidebar game list must be an array.';
    END IF;

    DELETE FROM public.stash_sidebar_games AS saved
    WHERE saved.profile_id = p_profile_id
      AND NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset(COALESCE(p_games, '[]'::jsonb)) AS desired(game_id text, title text)
          WHERE lower(btrim(desired.game_id)) = saved.game_id
      );

    INSERT INTO public.stash_sidebar_games (profile_id, game_id, title, updated_at)
    SELECT p_profile_id,
           lower(btrim(desired.game_id)),
           COALESCE(NULLIF(btrim(desired.title), ''), btrim(desired.game_id)),
           now()
    FROM jsonb_to_recordset(COALESCE(p_games, '[]'::jsonb)) AS desired(game_id text, title text)
    WHERE desired.game_id IS NOT NULL AND btrim(desired.game_id) <> ''
    ON CONFLICT (profile_id, game_id)
    DO UPDATE SET title = EXCLUDED.title, updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.get_stash_sidebar_popularity()
RETURNS TABLE (game_id text, title text, user_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT saved.game_id,
           min(saved.title) AS title,
           count(*)::bigint AS user_count
    FROM public.stash_sidebar_games AS saved
    GROUP BY saved.game_id
    ORDER BY count(*) DESC, min(saved.title) ASC
    LIMIT 100;
$$;

REVOKE ALL ON FUNCTION public.sync_stash_sidebar_games(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_stash_sidebar_popularity() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_stash_sidebar_games(text, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_stash_sidebar_popularity() TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
