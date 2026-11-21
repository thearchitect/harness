-- open.applescript <Ghostty.app> <command> <directory>...: a new window of that
-- Ghostty running <command> in each directory (harness-open). The terms come
-- from the bundled Ghostty (AppleScript since Ghostty 1.3).
on run argv
	set ghosttyApp to item 1 of argv
	set theCommand to item 2 of argv

	using terms from application "@ghostty@"
		tell application ghosttyApp
			repeat with theDirectory in items 3 thru -1 of argv
				set cfg to new surface configuration
				set initial working directory of cfg to (contents of theDirectory)
				set command of cfg to theCommand
				new window with configuration cfg
			end repeat

			activate
		end tell
	end using terms from
end run
