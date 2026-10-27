-- When a Creator deletes a group, remove every dependent row in the same transaction.
-- Running this from the group DELETE trigger also passes the Creator-membership protection trigger's nested-delete guard.
CREATE OR REPLACE FUNCTION public.nexus_cleanup_group_before_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    DELETE FROM public.group_members WHERE group_code = OLD.code;
    DELETE FROM public.group_requests WHERE group_code = OLD.code;
    DELETE FROM public.group_messages WHERE group_code = OLD.code;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS nexus_groups_cleanup_before_delete ON public.groups;
CREATE TRIGGER nexus_groups_cleanup_before_delete
BEFORE DELETE ON public.groups
FOR EACH ROW EXECUTE FUNCTION public.nexus_cleanup_group_before_delete();

NOTIFY pgrst, 'reload schema';