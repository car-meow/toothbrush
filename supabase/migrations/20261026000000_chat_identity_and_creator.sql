-- Store shared group identity state and enforce the creator's immutable membership.
-- The legacy admin_id field is a comma-separated list whose first value is the creator.

ALTER TABLE public.groups
    ADD COLUMN IF NOT EXISTS creator_id text;

UPDATE public.groups
SET creator_id = NULLIF(BTRIM(SPLIT_PART(COALESCE(admin_id, ''), ',', 1)), '')
WHERE creator_id IS NULL;

ALTER TABLE public.group_members
    ADD COLUMN IF NOT EXISTS display_name text,
    ADD COLUMN IF NOT EXISTS rainbow_active boolean NOT NULL DEFAULT false;

ALTER TABLE public.group_requests
    ADD COLUMN IF NOT EXISTS display_name text,
    ADD COLUMN IF NOT EXISTS rainbow_active boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS user_color text;

CREATE OR REPLACE FUNCTION public.nexus_enforce_group_creator_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    normalized_admin_ids text[];
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.creator_id IS NOT NULL AND NEW.creator_id IS DISTINCT FROM OLD.creator_id THEN
        RAISE EXCEPTION 'The group creator cannot be transferred.';
    END IF;

    IF NEW.creator_id IS NULL OR BTRIM(NEW.creator_id) = '' THEN
        RAISE EXCEPTION 'A group must have exactly one creator.';
    END IF;

    normalized_admin_ids := string_to_array(REGEXP_REPLACE(COALESCE(NEW.admin_id, ''), '\s+', '', 'g'), ',');
    IF NOT (NEW.creator_id = ANY(normalized_admin_ids)) THEN
        RAISE EXCEPTION 'The creator must retain group admin access.';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS nexus_groups_creator_role_guard ON public.groups;
CREATE TRIGGER nexus_groups_creator_role_guard
BEFORE INSERT OR UPDATE OF creator_id, admin_id ON public.groups
FOR EACH ROW EXECUTE FUNCTION public.nexus_enforce_group_creator_role();

CREATE OR REPLACE FUNCTION public.nexus_protect_creator_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    protected_creator_id text;
BEGIN
    IF pg_trigger_depth() > 1 THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        RETURN NEW;
    END IF;

    SELECT creator_id INTO protected_creator_id
    FROM public.groups
    WHERE code = OLD.group_code;

    IF protected_creator_id IS NOT NULL AND OLD.user_id::text = protected_creator_id THEN
        IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'The group creator cannot be removed.';
        END IF;
        IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.group_code IS DISTINCT FROM OLD.group_code THEN
            RAISE EXCEPTION 'The group creator membership cannot be reassigned.';
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS nexus_group_members_creator_guard ON public.group_members;
CREATE TRIGGER nexus_group_members_creator_guard
BEFORE DELETE OR UPDATE OF group_code, user_id ON public.group_members
FOR EACH ROW EXECUTE FUNCTION public.nexus_protect_creator_membership();

-- Refresh Supabase/PostgREST so the app can see the added columns immediately.
NOTIFY pgrst, 'reload schema';
